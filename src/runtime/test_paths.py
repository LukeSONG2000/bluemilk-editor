from pathlib import Path

def logs():
    path = Path(__file__).resolve().parents[2] / "logs" / "runtime-tests"
    path.mkdir(parents=True, exist_ok=True)
    return path
