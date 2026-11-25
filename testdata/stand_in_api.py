#!/usr/bin/env python3
"""A stand-in for an OpenAI-compatible API, for testing the apps' API route without an account.

    python3 testdata/stand_in_api.py [port]        (default 8089; address http://127.0.0.1:8089/v1)

POST /v1/audio/transcriptions checks that the upload is a real multipart form with a WAV file and
answers with a sentence that describes what arrived, so a test can see its own request reflected.
POST /v1/chat/completions answers the last user message with its fillers removed, or, when the
model's name is "chatty", with an answer to it, to exercise the apps' guard.
Requests are printed, without the audio and with the key shortened.
"""
import io
import json
import re
import sys
import wave
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SPOKEN = "Um, so the stand-in heard {seconds:.1f} seconds, uh, for model {model}, language {language}."


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def answer(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
        self.end_headers()

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        key = self.headers.get("Authorization", "")
        shown = key[:13] + "…" if key else "none"
        if key == "Bearer wrong":
            return self.answer(401, {"error": {"message": "Incorrect API key provided"}})

        if self.path.endswith("/audio/transcriptions"):
            head = f"Content-Type: {self.headers.get('Content-Type', '')}\r\n\r\n".encode()
            form = BytesParser(policy=default).parsebytes(head + body)
            if not form.is_multipart():
                return self.answer(400, {"error": {"message": "expected multipart/form-data"}})
            fields, audio = {}, None
            for part in form.iter_parts():
                name = part.get_param("name", header="content-disposition")
                if name == "file":
                    audio = part.get_payload(decode=True)
                else:
                    fields[name] = part.get_content().strip()
            try:
                with wave.open(io.BytesIO(audio or b"")) as clip:
                    seconds = clip.getnframes() / clip.getframerate()
                    shape = f"{clip.getframerate()} Hz, {clip.getsampwidth() * 8}-bit, {clip.getnchannels()} channel"
            except (wave.Error, EOFError) as error:
                return self.answer(400, {"error": {"message": f"the file is not a WAV recording: {error}"}})
            print(f"transcription: {seconds:.1f} s ({shape}), fields {fields}, key {shown}", flush=True)
            text = SPOKEN.format(seconds=seconds, model=fields.get("model", "?"), language=fields.get("language", "not given"))
            return self.answer(200, {"text": text})

        if self.path.endswith("/chat/completions"):
            request = json.loads(body)
            said = re.sub(r"</?transcript>", "", request["messages"][-1]["content"])
            print(f"chat: model {request.get('model')}, {len(request['messages'])} messages, key {shown}", flush=True)
            if request.get("model") == "chatty":
                reply = "Sure! Here is a much longer answer that nobody asked for, with plenty of brand new words in it."
            else:
                reply = re.sub(r"\b(um|uh),? ?", "", said, flags=re.I).strip()
                reply = reply[:1].upper() + reply[1:]
            return self.answer(200, {"choices": [{"message": {"role": "assistant", "content": reply}}]})

        self.answer(404, {"error": {"message": f"no such endpoint: {self.path}"}})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8089
    print(f"stand-in API at http://127.0.0.1:{port}/v1", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
