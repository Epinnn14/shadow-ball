"""Runs the JavaScript tests of the demo's decision logic when node is installed."""

import os
import shutil
import subprocess

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_decide_js():
    out = subprocess.run(["node", os.path.join(HERE, "decide_test.js")], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr + out.stdout
