#!/usr/bin/env python3
"""Deterministic state and git plumbing for the /factory skill.

The orchestrator calls this helper for everything that must be exact: board.json
edits, job ids, worktrees, ports, round bookkeeping and the serial merge queue.
Judgement (specs, code, reviews) stays with the agents. Every command prints JSON.

Run from the MAIN checkout:  python3 <skill-dir>/scripts/factory.py <command> ...
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

logger = logging.getLogger("factory")

TEMPLATES = Path(__file__).resolve().parent.parent / "templates"
REVIEWERS = ("security", "ux", "ui", "code")
ACTIVE_STAGES = frozenset({"spec", "build", "review", "approve"})
STAGES = ("queued", "spec", "build", "review", "approve", "merge-queue", "merged", "needs-human")
WORKTREES_DIR = ".factory-worktrees"
AGENTS_BEGIN = "<!-- factory:begin -->"
AGENTS_END = "<!-- factory:end -->"
MAX_MERGE_ATTEMPTS = 2
SLUG_WORDS = 5
SLUG_STOPWORDS = frozenset(
    {
        "a", "an", "the", "to", "of", "for", "and", "or", "that", "which", "with", "as", "in", "on", "into",
        "by", "is", "are", "be", "it", "its", "this", "so", "should", "please",
        "add", "implement", "create", "make", "new",
    }
)  # fmt: skip
OUTPUT_TAIL = 3000

Job = dict[str, Any]
Board = dict[str, Any]


class FactoryError(Exception):
    """A factory command could not be completed."""


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _sh(cmd: list[str] | str, cwd: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    """Run a command, never raising on a non-zero exit."""
    return subprocess.run(
        cmd,
        cwd=cwd,
        shell=isinstance(cmd, str),
        capture_output=True,
        text=True,
        env={**os.environ, **(env or {})},
    )


def _git(cwd: Path, *args: str) -> str:
    """Run git and return stdout, raising FactoryError on failure."""
    result = _sh(["git", *args], cwd)
    if result.returncode != 0:
        raise FactoryError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def _tail(text: str) -> str:
    return text[-OUTPUT_TAIL:]


def slugify(title: str) -> str:
    """Turn a feature request into a short kebab-case slug (at most 5 meaningful words)."""
    words = [w for w in re.findall(r"[a-z0-9]+", title.lower()) if w not in SLUG_STOPWORDS]
    return "-".join(words[:SLUG_WORDS])[:40].rstrip("-") or "job"


def read_verdict(path: Path, allowed: tuple[str, ...]) -> str | None:
    """Return the first-line verdict of a review/decision file, if present and valid."""
    if not path.exists():
        return None
    for line in path.read_text().splitlines():
        if line.strip():
            words = re.findall(r"[A-Z]+", line.upper())
            return next((w for w in words if w in allowed), "INVALID")
    return "INVALID"


class Factory:
    """All factory operations against one main checkout."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.state = root / "factory"
        self.board_path = self.state / "board.json"
        self.jobs_dir = self.state / "jobs"

    @classmethod
    def from_cwd(cls, cwd: Path) -> Factory:
        """Locate the main checkout from any directory inside the repo."""
        top = Path(_git(cwd, "rev-parse", "--show-toplevel"))
        common = Path(_git(top, "rev-parse", "--path-format=absolute", "--git-common-dir"))
        main_root = common.parent if common.name == ".git" else top
        if main_root.resolve() != top.resolve():
            raise FactoryError(f"run the factory from the main checkout ({main_root}), not a worktree")
        return cls(top)

    # ----- board -------------------------------------------------------------

    def load(self) -> Board:
        """Read board.json."""
        if not self.board_path.exists():
            raise FactoryError("factory not initialised: run `/factory init`")
        board: Board = json.loads(self.board_path.read_text())
        return board

    def save(self, board: Board) -> None:
        """Atomically write board.json."""
        tmp = self.board_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(board, indent=2) + "\n")
        os.replace(tmp, self.board_path)

    def job(self, board: Board, job_id: str) -> Job:
        """Find a job by id."""
        jobs: list[Job] = board["jobs"]
        for job in jobs:
            if job["id"] == job_id:
                return job
        raise FactoryError(f"unknown job {job_id}")

    def _touch(self, job: Job, **fields: Any) -> Job:
        job.update(fields, updated=_now())
        return job

    def _add_file(self, job: Job, rel: str) -> None:
        if rel not in job["files"]:
            job["files"].append(rel)

    # ----- setup -------------------------------------------------------------

    def init(self, max_parallel: int, base_port: int, openspec: bool) -> dict[str, Any]:
        """Create factory state, gitignore entry, AGENTS.md section and OpenSpec."""
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        (self.jobs_dir / ".gitkeep").touch()
        created = []
        if not self.board_path.exists():
            branch = _git(self.root, "rev-parse", "--abbrev-ref", "HEAD")
            self.save(
                {
                    "max_parallel": max_parallel,
                    "repo": {"main_branch": branch, "base_port": base_port, "install": "", "test": "", "dev": ""},
                    "merge_queue": [],
                    "jobs": [],
                }
            )
            created.append("factory/board.json")
        backlog = self.state / "backlog.md"
        if not backlog.exists():
            shutil.copy(TEMPLATES / "backlog.md", backlog)
            created.append("factory/backlog.md")
        shutil.copy(TEMPLATES / "dashboard.html", self.state / "dashboard.html")
        self._ensure_gitignore()
        self._ensure_agents_section()
        if openspec and not (self.root / "openspec").exists():
            result = _sh(["openspec", "init", "--tools", "oh-my-pi"], self.root)
            if result.returncode != 0:
                raise FactoryError(f"openspec init failed: {result.stderr.strip() or result.stdout.strip()}")
            created.append("openspec/")
        return {"root": str(self.root), "created": created, "board": self.load()}

    def _ensure_gitignore(self) -> None:
        path = self.root / ".gitignore"
        lines = path.read_text().splitlines() if path.exists() else []
        wanted = [f"{WORKTREES_DIR}/", "factory/.merge.lock", "factory/board.json.tmp"]
        missing = [w for w in wanted if w not in lines]
        if missing:
            path.write_text("\n".join([*lines, *missing]) + "\n")

    def _ensure_agents_section(self) -> None:
        path = self.root / "AGENTS.md"
        text = path.read_text() if path.exists() else ""
        section = (TEMPLATES / "AGENTS.section.md").read_text().strip()
        block = f"{AGENTS_BEGIN}\n{section}\n{AGENTS_END}"
        if AGENTS_BEGIN in text:
            text = re.sub(re.escape(AGENTS_BEGIN) + r".*?" + re.escape(AGENTS_END), lambda _: block, text, flags=re.S)
        else:
            text = (text.rstrip() + "\n\n" if text.strip() else "") + block
        path.write_text(text.rstrip() + "\n")

    def profile(self, updates: dict[str, Any]) -> dict[str, Any]:
        """Record the repo's install/test/dev commands and base port."""
        board = self.load()
        board["repo"].update({k: v for k, v in updates.items() if v is not None})
        self.save(board)
        repo: dict[str, Any] = board["repo"]
        return repo

    def parallel(self, n: int) -> dict[str, Any]:
        """Set max_parallel."""
        if n < 1:
            raise FactoryError("max_parallel must be >= 1")
        board = self.load()
        board["max_parallel"] = n
        self.save(board)
        return {"max_parallel": n}

    # ----- job lifecycle -----------------------------------------------------

    def new(self, title: str) -> Job:
        """Register a queued job with the next id (job-NNN-slug)."""
        board = self.load()
        numbers = [int(m.group(1)) for j in board["jobs"] if (m := re.match(r"job-(\d+)-", j["id"]))]
        number = max(numbers, default=0) + 1
        job_id = f"job-{number:03d}-{slugify(title)}"
        job: Job = {
            "id": job_id,
            "title": title,
            "number": number,
            "branch": f"factory/{job_id}",
            "worktree": f"{WORKTREES_DIR}/{job_id}",
            "port": board["repo"]["base_port"] + number,
            "stage": "queued",
            "round": 0,
            "merge_attempts": 0,
            "files": [],
            "reviews": dict.fromkeys(REVIEWERS, "pending"),
            "note": "",
            "created": _now(),
            "updated": _now(),
        }
        board["jobs"].append(job)
        self.save(board)
        return job

    def start(self, install: bool) -> dict[str, Any]:
        """Start queued jobs while slots are free: worktree, branch, install."""
        board = self.load()
        active = sum(1 for j in board["jobs"] if j["stage"] in ACTIVE_STAGES)
        base = _git(self.root, "rev-parse", board["repo"]["main_branch"])
        started, warnings = [], []
        for job in board["jobs"]:
            if active >= board["max_parallel"]:
                break
            if job["stage"] != "queued":
                continue
            wt = self.root / job["worktree"]
            _git(self.root, "worktree", "add", "-q", str(wt), "-b", job["branch"], base)
            (self.jobs_dir / job["id"]).mkdir(parents=True, exist_ok=True)
            if install and board["repo"]["install"]:
                result = _sh(board["repo"]["install"], wt, {"PORT": str(job["port"])})
                if result.returncode != 0:
                    warnings.append({"id": job["id"], "install": _tail(result.stderr or result.stdout)})
            self._touch(job, stage="spec", base=base)
            started.append(job)
            active += 1
        self.save(board)
        queued = [j["id"] for j in board["jobs"] if j["stage"] == "queued"]
        return {"started": started, "still_queued": queued, "warnings": warnings}

    def set(self, job_id: str, stage: str | None, rnd: int | None, note: str | None, files: list[str]) -> Job:
        """Update a job's stage, round, note or file list."""
        board = self.load()
        job = self.job(board, job_id)
        if stage:
            if stage not in STAGES:
                raise FactoryError(f"unknown stage {stage}; expected one of {', '.join(STAGES)}")
            job["stage"] = stage
            if stage != "merge-queue" and job_id in board["merge_queue"]:
                board["merge_queue"].remove(job_id)
        if rnd is not None:
            job["round"] = rnd
        if note is not None:
            job["note"] = note
        for rel in files:
            self._add_file(job, rel)
        self._touch(job)
        self.save(board)
        return job

    def round(self, job_id: str, rnd: int) -> dict[str, Any]:
        """Open review round N: folder, stage=review, reviewer chips reset."""
        board = self.load()
        job = self.job(board, job_id)
        folder = self.jobs_dir / job_id / f"round-{rnd}"
        folder.mkdir(parents=True, exist_ok=True)
        self._touch(job, stage="review", round=rnd, reviews=dict.fromkeys(REVIEWERS, "pending"))
        self.save(board)
        return {
            "id": job_id,
            "round": rnd,
            "round_dir": str(folder),
            "outputs": {r: str(folder / f"review-{r}.md") for r in REVIEWERS},
        }

    def collect(self, job_id: str) -> dict[str, Any]:
        """Read verdicts of the current round; complete only when all four exist."""
        board = self.load()
        job = self.job(board, job_id)
        rel_dir = f"factory/jobs/{job_id}/round-{job['round']}"
        verdicts: dict[str, str] = {}
        for reviewer in REVIEWERS:
            rel = f"{rel_dir}/review-{reviewer}.md"
            verdict = read_verdict(self.root / rel, ("PASS", "CHANGES"))
            verdicts[reviewer] = verdict or "pending"
            if verdict:
                self._add_file(job, rel)
        self._touch(job, reviews=verdicts)
        self.save(board)
        complete = all(v != "pending" for v in verdicts.values())
        invalid = [r for r, v in verdicts.items() if v == "INVALID"]
        return {
            "id": job_id,
            "round": job["round"],
            "complete": complete,
            "verdicts": verdicts,
            "invalid": invalid,
            "all_pass": complete and all(v == "PASS" for v in verdicts.values()),
            "changes": [r for r, v in verdicts.items() if v == "CHANGES"],
        }

    def decide(self, job_id: str) -> dict[str, Any]:
        """Apply the approver's decision.md: APPROVE -> merge queue, ESCALATE -> needs-human."""
        rel = f"factory/jobs/{job_id}/decision.md"
        decision = read_verdict(self.root / rel, ("APPROVE", "ESCALATE"))
        if decision not in ("APPROVE", "ESCALATE"):
            raise FactoryError(f"{rel} missing or does not start with APPROVE/ESCALATE")
        board = self.load()
        job = self.job(board, job_id)
        self._add_file(job, rel)
        if decision == "APPROVE":
            self._enqueue(board, job)
        else:
            self._touch(job, stage="needs-human", note="approver escalated")
        self.save(board)
        return {"id": job_id, "decision": decision, "stage": job["stage"]}

    def enqueue(self, job_id: str) -> dict[str, Any]:
        """Put a job in the merge queue (used by /factory approve and after merge fixes)."""
        board = self.load()
        job = self.job(board, job_id)
        self._enqueue(board, job)
        self.save(board)
        return {"id": job_id, "merge_queue": board["merge_queue"]}

    def _enqueue(self, board: Board, job: Job) -> None:
        if job["stage"] == "merged":
            raise FactoryError(f"{job['id']} is already merged")
        self._touch(job, stage="merge-queue")
        if job["id"] not in board["merge_queue"]:
            board["merge_queue"].append(job["id"])

    # ----- merge queue -------------------------------------------------------

    @contextmanager
    def _merge_lock(self) -> Iterator[None]:
        lock = self.state / ".merge.lock"
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError as e:
            raise FactoryError(f"merge already running (remove {lock} if stale)") from e
        try:
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            yield
        finally:
            lock.unlink(missing_ok=True)

    def merge(self, job_id: str | None) -> dict[str, Any]:
        """Merge the next queued job: rebase, test, fast-forward, archive, remove worktree."""
        with self._merge_lock():
            board = self.load()
            if not board["merge_queue"]:
                return {"ok": True, "merged": None, "detail": "merge queue empty"}
            job = self.job(board, job_id or board["merge_queue"][0])
            repo = board["repo"]
            main, wt = repo["main_branch"], self.root / job["worktree"]

            current = _git(self.root, "rev-parse", "--abbrev-ref", "HEAD")
            porcelain = _sh(["git", "status", "--porcelain"], self.root).stdout
            dirty = [line for line in porcelain.splitlines() if line and not line[3:].startswith("factory/")]
            if current != main or dirty:
                return {
                    "ok": False,
                    "id": job["id"],
                    "reason": "main-not-clean",
                    "next": "retry",
                    "detail": f"main checkout must be on {main} with no changes outside factory/: {dirty}",
                }

            rebase = _sh(["git", "rebase", main], wt)
            if rebase.returncode != 0:
                conflicts = _sh(["git", "diff", "--name-only", "--diff-filter=U"], wt).stdout.strip()
                _sh(["git", "rebase", "--abort"], wt)
                return self._merge_failed(board, job, "rebase-conflict", f"conflicting files:\n{conflicts}")

            if repo["test"]:
                tests = _sh(repo["test"], wt, {"PORT": str(job["port"])})
                if tests.returncode != 0:
                    return self._merge_failed(board, job, "tests-failed", _tail(tests.stdout + tests.stderr))

            _git(self.root, "merge", "--ff-only", "-q", job["branch"])
            board["merge_queue"] = [j for j in board["merge_queue"] if j != job["id"]]
            try:
                archived = self._archive(job)
            except FactoryError as e:
                self._touch(job, stage="needs-human", note="merged, but OpenSpec archive failed")
                self.save(board)
                return {
                    "ok": False,
                    "id": job["id"],
                    "reason": "archive-failed",
                    "detail": str(e),
                    "next": "needs-human",
                }
            self._touch(job, stage="merged", note="", merged_at=_now())
            self.save(board)
            paths = [p for p in ("openspec", "factory") if (self.root / p).exists()]
            _git(self.root, "add", "-A", "--", *paths)
            if _sh(["git", "diff", "--cached", "--quiet"], self.root).returncode != 0:
                _git(self.root, "commit", "-q", "-m", f"factory: archive {job['id']}")
            removed = _sh(["git", "worktree", "remove", str(wt)], self.root)
            return {
                "ok": True,
                "id": job["id"],
                "archived": archived,
                "worktree_removed": removed.returncode == 0,
                "detail": removed.stderr.strip(),
                "merge_queue": board["merge_queue"],
            }

    def _merge_failed(self, board: Board, job: Job, reason: str, detail: str) -> dict[str, Any]:
        job["merge_attempts"] = job.get("merge_attempts", 0) + 1
        nxt = "build" if job["merge_attempts"] < MAX_MERGE_ATTEMPTS else "needs-human"
        self._touch(job, stage=nxt, note=f"merge {reason}")
        board["merge_queue"] = [j for j in board["merge_queue"] if j != job["id"]]
        self.save(board)
        return {"ok": False, "id": job["id"], "reason": reason, "detail": detail, "next": nxt}

    def _archive(self, job: Job) -> str | None:
        """Archive the job's OpenSpec change in the main checkout and repoint its files."""
        change = self.root / "openspec" / "changes" / job["id"]
        if not change.exists():
            return None
        result = _sh(["openspec", "archive", job["id"], "-y"], self.root)
        if result.returncode != 0:
            raise FactoryError(f"openspec archive {job['id']} failed: {_tail(result.stdout + result.stderr)}")
        archive_root = self.root / "openspec" / "changes" / "archive"
        matches = sorted(archive_root.glob(f"*-{job['id']}"))
        if not matches:
            return None
        archived = str(matches[-1].relative_to(self.root))
        old_prefix = f"{job['worktree']}/openspec/changes/{job['id']}/"
        job["files"] = [f.replace(old_prefix, f"{archived}/") for f in job["files"]]
        return archived

    # ----- housekeeping ------------------------------------------------------

    def status(self) -> dict[str, Any]:
        """Summarise the board."""
        board = self.load()
        active = sum(1 for j in board["jobs"] if j["stage"] in ACTIVE_STAGES)
        return {
            "max_parallel": board["max_parallel"],
            "free_slots": max(board["max_parallel"] - active, 0),
            "merge_queue": board["merge_queue"],
            "jobs": [{k: j[k] for k in ("id", "stage", "round", "port", "reviews", "note")} for j in board["jobs"]],
        }

    def cleanup(self) -> dict[str, Any]:
        """Remove worktrees of merged jobs and prune git's worktree list."""
        board = self.load()
        removed = []
        for job in board["jobs"]:
            wt = self.root / job["worktree"]
            if job["stage"] == "merged" and wt.exists():
                result = _sh(["git", "worktree", "remove", str(wt)], self.root)
                if result.returncode == 0:
                    removed.append(job["id"])
                else:
                    logger.warning("could not remove %s: %s", wt, result.stderr.strip())
        _git(self.root, "worktree", "prune")
        return {"removed": removed}


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="factory.py", description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("init", help="create factory/ state in this repo")
    s.add_argument("--max-parallel", type=int, default=3)
    s.add_argument("--base-port", type=int, default=3000)
    s.add_argument("--no-openspec", action="store_true")
    s = sub.add_parser("profile", help="record repo commands")
    for flag in ("install", "test", "dev", "language", "main-branch"):
        s.add_argument(f"--{flag}")
    s.add_argument("--base-port", type=int)
    sub.add_parser("parallel").add_argument("n", type=int)
    sub.add_parser("new").add_argument("title", nargs="+")
    sub.add_parser("start").add_argument("--no-install", action="store_true")
    s = sub.add_parser("set")
    s.add_argument("id")
    s.add_argument("--stage")
    s.add_argument("--round", type=int)
    s.add_argument("--note")
    s.add_argument("--add-file", action="append", default=[])
    s = sub.add_parser("round")
    s.add_argument("id")
    s.add_argument("n", type=int)
    for name in ("collect", "decide", "enqueue"):
        sub.add_parser(name).add_argument("id")
    sub.add_parser("merge").add_argument("id", nargs="?")
    sub.add_parser("status")
    sub.add_parser("cleanup")
    return p


def run_cli(argv: list[str], cwd: Path) -> Any:
    """Parse argv and execute one command; returns the JSON-serialisable result."""
    args = _parser().parse_args(argv)
    fac = Factory.from_cwd(cwd)
    match args.cmd:
        case "init":
            return fac.init(args.max_parallel, args.base_port, not args.no_openspec)
        case "profile":
            keys = ("install", "test", "dev", "language", "main_branch", "base_port")
            return fac.profile({k: getattr(args, k) for k in keys})
        case "parallel":
            return fac.parallel(args.n)
        case "new":
            return fac.new(" ".join(args.title))
        case "start":
            return fac.start(install=not args.no_install)
        case "set":
            return fac.set(args.id, args.stage, args.round, args.note, args.add_file)
        case "round":
            return fac.round(args.id, args.n)
        case "collect":
            return fac.collect(args.id)
        case "decide":
            return fac.decide(args.id)
        case "enqueue":
            return fac.enqueue(args.id)
        case "merge":
            return fac.merge(args.id)
        case "status":
            return fac.status()
        case "cleanup":
            return fac.cleanup()
    raise FactoryError(f"unknown command {args.cmd}")


def main() -> int:
    """CLI entry point."""
    logging.basicConfig(level=logging.INFO, format="factory: %(message)s", stream=sys.stderr)
    try:
        result = run_cli(sys.argv[1:], Path.cwd())
    except FactoryError as e:
        sys.stdout.write(json.dumps({"ok": False, "error": str(e)}) + "\n")
        return 1
    sys.stdout.write(json.dumps(result, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
