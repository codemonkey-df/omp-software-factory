"""Tests for the factory helper (skills/factory/scripts/factory.py)."""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "skills" / "factory" / "scripts" / "factory.py"
_spec = importlib.util.spec_from_file_location("factory", SCRIPT)
assert _spec and _spec.loader
factory = importlib.util.module_from_spec(_spec)
sys.modules["factory"] = factory
_spec.loader.exec_module(factory)

REVIEWERS = ("security", "ux", "ui", "code")


def git(repo: Path, *args: str) -> str:
    """Run git in repo and return stdout."""
    result = subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)
    return result.stdout.strip()


def run(repo: Path, *argv: str) -> Any:
    """Invoke the helper CLI in-process and return its JSON output."""
    return factory.run_cli(list(argv), cwd=repo)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A git repo on branch main with one commit and an initialised factory."""
    root = tmp_path / "app"
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.email", "factory@test")
    git(root, "config", "user.name", "factory")
    (root / "app.txt").write_text("v1\n")
    git(root, "add", ".")
    git(root, "commit", "-qm", "init")
    run(root, "init", "--no-openspec")
    run(root, "profile", "--test", "true", "--install", "")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "factory init")
    return root


def board(repo: Path) -> dict[str, Any]:
    """Read the board from disk."""
    return json.loads((repo / "factory" / "board.json").read_text())


def job(repo: Path, job_id: str) -> dict[str, Any]:
    """Find one job on the board."""
    return next(j for j in board(repo)["jobs"] if j["id"] == job_id)


def write_reviews(repo: Path, job_id: str, rnd: int, verdicts: dict[str, str]) -> None:
    """Write reviewer files for a round."""
    folder = repo / "factory" / "jobs" / job_id / f"round-{rnd}"
    for name, verdict in verdicts.items():
        (folder / f"review-{name}.md").write_text(f"VERDICT: {verdict}\n\nnotes\n")


def builder_commit(repo: Path, job_id: str, filename: str, content: str) -> None:
    """Simulate the builder committing in the job's worktree."""
    wt = repo / job(repo, job_id)["worktree"]
    (wt / filename).write_text(content)
    git(wt, "add", ".")
    git(wt, "commit", "-qm", f"{job_id}: work")


def test_init_creates_state_and_is_idempotent(repo: Path) -> None:
    run(repo, "init", "--no-openspec")
    assert board(repo)["max_parallel"] == 3
    assert board(repo)["repo"]["main_branch"] == "main"
    assert (repo / "factory" / "dashboard.html").exists()
    assert (repo / "factory" / "backlog.md").exists()
    assert (repo / ".gitignore").read_text().count(".factory-worktrees/") == 1
    assert (repo / "AGENTS.md").read_text().count("factory:begin") == 1


def test_new_allocates_letter_prefixed_sequential_ids(repo: Path) -> None:
    first = run(repo, "new", "Rate limiting")
    second = run(repo, "new", "Search filters!")
    assert first["id"] == "job-001-rate-limiting"
    assert second["id"] == "job-002-search-filters"
    assert job(repo, first["id"])["stage"] == "queued"


def test_slug_drops_filler_words_and_stays_short() -> None:
    title = 'add a GET /time endpoint that returns the current server time as JSON {"time": ...}'
    assert factory.slugify(title) == "get-time-endpoint-returns-current"
    assert factory.slugify("!!!") == "job"


def test_start_respects_max_parallel_and_creates_worktrees(repo: Path) -> None:
    run(repo, "parallel", "2")
    ids = [run(repo, "new", f"feature {n}")["id"] for n in range(3)]
    started = run(repo, "start", "--no-install")
    assert [j["id"] for j in started["started"]] == ids[:2]
    first = job(repo, ids[0])
    assert first["stage"] == "spec"
    assert first["branch"] == f"factory/{ids[0]}"
    assert first["port"] == 3001
    assert (repo / first["worktree"] / "app.txt").exists()
    assert job(repo, ids[2])["stage"] == "queued"


def test_collect_waits_for_all_four_reviews(repo: Path) -> None:
    job_id = run(repo, "new", "x")["id"]
    run(repo, "start", "--no-install")
    run(repo, "round", job_id, "1")
    write_reviews(repo, job_id, 1, {"security": "PASS", "ux": "CHANGES"})
    partial = run(repo, "collect", job_id)
    assert partial["complete"] is False
    assert job(repo, job_id)["reviews"] == {"security": "PASS", "ux": "CHANGES", "ui": "pending", "code": "pending"}

    write_reviews(repo, job_id, 1, {"ui": "PASS", "code": "PASS"})
    done = run(repo, "collect", job_id)
    assert done["complete"] is True
    assert done["all_pass"] is False
    assert f"factory/jobs/{job_id}/round-1/review-ux.md" in job(repo, job_id)["files"]


def test_decide_routes_approve_and_escalate(repo: Path) -> None:
    a = run(repo, "new", "a")["id"]
    b = run(repo, "new", "b")["id"]
    run(repo, "start", "--no-install")
    (repo / "factory" / "jobs" / a / "decision.md").write_text("APPROVE\n\nok\n")
    (repo / "factory" / "jobs" / b / "decision.md").write_text("ESCALATE\n\nrisky\n")
    assert run(repo, "decide", a)["decision"] == "APPROVE"
    assert run(repo, "decide", b)["decision"] == "ESCALATE"
    assert job(repo, a)["stage"] == "merge-queue"
    assert job(repo, b)["stage"] == "needs-human"
    assert board(repo)["merge_queue"] == [a]


def test_merge_success_merges_and_removes_worktree(repo: Path) -> None:
    job_id = run(repo, "new", "feature")["id"]
    run(repo, "start", "--no-install")
    builder_commit(repo, job_id, "feature.txt", "hello\n")
    run(repo, "enqueue", job_id)

    result = run(repo, "merge")
    assert result["ok"] is True
    assert (repo / "feature.txt").read_text() == "hello\n"
    assert job(repo, job_id)["stage"] == "merged"
    assert board(repo)["merge_queue"] == []
    assert not (repo / ".factory-worktrees" / job_id).exists()
    assert git(repo, "branch", "--list", f"factory/{job_id}")
    assert git(repo, "status", "--porcelain") == ""


def test_merge_rebases_onto_new_main(repo: Path) -> None:
    a = run(repo, "new", "a")["id"]
    b = run(repo, "new", "b")["id"]
    run(repo, "start", "--no-install")
    builder_commit(repo, a, "a.txt", "a\n")
    builder_commit(repo, b, "b.txt", "b\n")
    run(repo, "enqueue", a)
    run(repo, "enqueue", b)
    assert run(repo, "merge")["ok"] is True
    assert run(repo, "merge")["ok"] is True
    assert (repo / "a.txt").exists() and (repo / "b.txt").exists()


def test_merge_conflict_goes_back_to_builder_then_needs_human(repo: Path) -> None:
    a = run(repo, "new", "a")["id"]
    b = run(repo, "new", "b")["id"]
    run(repo, "start", "--no-install")
    builder_commit(repo, a, "app.txt", "from a\n")
    builder_commit(repo, b, "app.txt", "from b\n")
    run(repo, "enqueue", a)
    run(repo, "enqueue", b)
    assert run(repo, "merge")["ok"] is True

    first = run(repo, "merge")
    assert first == {**first, "ok": False, "reason": "rebase-conflict", "next": "build"}
    assert "app.txt" in first["detail"]
    assert job(repo, b)["stage"] == "build"

    run(repo, "enqueue", b)
    second = run(repo, "merge")
    assert second["next"] == "needs-human"
    assert job(repo, b)["stage"] == "needs-human"


def test_successful_merge_clears_earlier_failure_note(repo: Path) -> None:
    a = run(repo, "new", "alpha")["id"]
    b = run(repo, "new", "beta")["id"]
    run(repo, "start", "--no-install")
    builder_commit(repo, a, "app.txt", "from a\n")
    builder_commit(repo, b, "app.txt", "from b\n")
    run(repo, "enqueue", a)
    run(repo, "enqueue", b)
    run(repo, "merge")
    run(repo, "merge")
    assert job(repo, b)["note"] == "merge rebase-conflict"

    wt = repo / job(repo, b)["worktree"]
    git(wt, "reset", "-q", "--hard", "main")
    builder_commit(repo, b, "b.txt", "b\n")
    run(repo, "enqueue", b)
    assert run(repo, "merge")["ok"] is True
    assert job(repo, b)["note"] == ""


def test_merge_failing_tests_are_reported(repo: Path) -> None:
    run(repo, "profile", "--test", "echo boom; exit 3")
    job_id = run(repo, "new", "x")["id"]
    run(repo, "start", "--no-install")
    builder_commit(repo, job_id, "x.txt", "x\n")
    run(repo, "enqueue", job_id)
    result = run(repo, "merge")
    assert result["reason"] == "tests-failed"
    assert "boom" in result["detail"]
    assert not (repo / "x.txt").exists()


def test_merge_refuses_when_another_merge_holds_the_lock(repo: Path) -> None:
    job_id = run(repo, "new", "x")["id"]
    run(repo, "start", "--no-install")
    run(repo, "enqueue", job_id)
    (repo / "factory" / ".merge.lock").write_text("busy")
    with pytest.raises(factory.FactoryError, match="merge already running"):
        run(repo, "merge")


def test_cleanup_removes_leftover_worktrees_of_merged_jobs(repo: Path) -> None:
    job_id = run(repo, "new", "x")["id"]
    run(repo, "start", "--no-install")
    data = board(repo)
    data["jobs"][0]["stage"] = "merged"
    (repo / "factory" / "board.json").write_text(json.dumps(data))
    result = run(repo, "cleanup")
    assert result["removed"] == [job_id]
    assert not (repo / ".factory-worktrees" / job_id).exists()


@pytest.mark.skipif(shutil.which("openspec") is None, reason="openspec CLI not installed")
def test_merge_archives_openspec_change(repo: Path) -> None:
    subprocess.run(["openspec", "init", "--tools", "none"], cwd=repo, check=True, capture_output=True)
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "openspec")
    job_id = run(repo, "new", "greeting")["id"]
    run(repo, "start", "--no-install")
    wt = repo / job(repo, job_id)["worktree"]
    subprocess.run(["openspec", "new", "change", job_id], cwd=wt, check=True, capture_output=True)
    change = wt / "openspec" / "changes" / job_id
    (change / "proposal.md").write_text("## Why\nGreet.\n\n## What Changes\n- greet\n")
    spec = change / "specs" / "greeting"
    spec.mkdir(parents=True)
    (spec / "spec.md").write_text(
        "## ADDED Requirements\n\n### Requirement: Greet\nThe system SHALL greet.\n\n"
        "#### Scenario: hello\n- **WHEN** asked\n- **THEN** it says hello\n"
    )
    (change / "tasks.md").write_text("- [x] 1.1 greet\n")
    git(wt, "add", "-A")
    git(wt, "commit", "-qm", "spec + impl")
    run(repo, "set", job_id, "--add-file", f"{job(repo, job_id)['worktree']}/openspec/changes/{job_id}/proposal.md")
    run(repo, "enqueue", job_id)

    result = run(repo, "merge")
    assert result["ok"] is True, result
    assert (repo / "openspec" / "specs" / "greeting" / "spec.md").exists()
    assert not (repo / "openspec" / "changes" / job_id).exists()
    archived = [f for f in job(repo, job_id)["files"] if "/archive/" in f]
    assert archived and (repo / archived[0]).exists()
