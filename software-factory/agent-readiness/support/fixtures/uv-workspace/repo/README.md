# uv-workspace

Two packages in one uv workspace, locked by the root `uv.lock`.

Install with `uv sync --all-packages`, then run each package's tests from its folder with `../../.venv/bin/python -m unittest discover -s tests -t .`.
