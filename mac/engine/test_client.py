"""Drive server.py the way the app does: python test_client.py [--model ID] [--cleanup smart] file.wav ..."""
import argparse, json, subprocess, sys, time
from pathlib import Path
import numpy as np, soundfile as sf

ap = argparse.ArgumentParser()
ap.add_argument("--model", default=None)
ap.add_argument("--cleanup", default="smart")
ap.add_argument("--language", default="English")
ap.add_argument("--vocab", default="")
ap.add_argument("files", nargs="+")
a = ap.parse_args()

cmd = [sys.executable, str(Path(__file__).with_name("server.py"))] + (["--model", a.model] if a.model else [])
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

def read_until(kinds):
    while True:
        line = p.stdout.readline()
        if not line:
            sys.exit("engine exited")
        msg = json.loads(line)
        if msg["event"] in kinds:
            return msg

t0 = time.perf_counter()
ready = read_until({"ready", "fatal"})
print("startup", round(time.perf_counter() - t0, 2), "s", ready)
for i, f in enumerate(a.files):
    x, sr = sf.read(f, dtype="float32")
    assert sr == 16000 and x.ndim == 1, (sr, x.shape)
    req = {"id": i, "op": "transcribe", "nbytes": x.nbytes, "language": a.language, "cleanup": a.cleanup,
           "stream": False, "vocabulary": [v for v in a.vocab.split(",") if v]}
    t0 = time.perf_counter()
    p.stdin.write((json.dumps(req) + "\n").encode() + x.tobytes()); p.stdin.flush()
    done = read_until({"done", "error"})
    print(f"\n== {f}  wall {time.perf_counter() - t0:.2f}s")
    if done["event"] == "error":
        print("ERROR", done["message"]); continue
    print("raw :", done["raw"]); print("text:", done["text"])
    print("time:", json.dumps(done["timings"]), done.get("note", ""))
p.stdin.close(); p.wait()
