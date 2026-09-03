#!/usr/bin/env python3
"""Mở web UI: python serve.py [--port 8765]"""

import argparse

from content_agent.web import serve

if __name__ == "__main__":
    parser = argparse.ArgumentParser(prog="content-agent-ui")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    serve(args.host, args.port)
