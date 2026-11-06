"""Loader for the gpupool runtime hooks (post-MVP P5, docs/POST_MVP_PLAN.md).

pool/lib.sh puts pool/hooks on PYTHONPATH and sets GPUPOOL_HOOKS=1, so every Python process of
`parallax run` / `parallax join` (and their children) imports this file at start. Parallax is not
modified: gpupool_hooks patches some of its classes after their modules are imported.
"""
import os
import sys

if os.environ.get("GPUPOOL_HOOKS") == "1":
    try:
        import gpupool_hooks

        gpupool_hooks.install()
    except Exception as e:  # never stop Parallax because of a hook
        print(f"gpupool hooks: install failed: {e}", file=sys.stderr)
