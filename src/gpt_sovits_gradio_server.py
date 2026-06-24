from __future__ import annotations

import argparse
import os
import runpy
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", required=True, type=int)
    arguments = parser.parse_args()

    root = Path(arguments.root).resolve()
    inference_script = root / "GPT_SoVITS" / "inference_webui.py"
    if not inference_script.is_file():
        raise FileNotFoundError(f"找不到原版推理程序: {inference_script}")

    os.chdir(root)
    sys.path.insert(0, str(root))
    sys.path.insert(0, str(root / "GPT_SoVITS"))
    module = runpy.run_path(
        str(inference_script),
        run_name="dialogue_bridge_native_gradio",
    )
    app = module["app"]
    app.queue().launch(
        server_name=arguments.host,
        server_port=arguments.port,
        inbrowser=False,
        share=False,
    )


if __name__ == "__main__":
    main()
