from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import traceback
from pathlib import Path


def fail(message: str, code: int = 1) -> None:
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    raise SystemExit(code)


def output_path_from_result(result) -> str:
    if isinstance(result, str):
        return result
    if isinstance(result, dict) and result.get("path"):
        return result["path"]
    if isinstance(result, (list, tuple)) and result:
        return output_path_from_result(result[0])
    raise ValueError(f"无法识别 GPT-SoVITS 返回结果: {result!r}")


def stage_file(source: str, directory: Path, name: str) -> Path:
    source_path = Path(source).resolve()
    if not source_path.is_file():
        raise FileNotFoundError(f"参考音频不存在: {source_path}")
    suffix = source_path.suffix.lower() or ".wav"
    staged = directory / f"{name}{suffix}"
    shutil.copyfile(source_path, staged)
    return staged


def main() -> None:
    os.environ.setdefault("NO_PROXY", "127.0.0.1,localhost")
    os.environ.setdefault("no_proxy", "127.0.0.1,localhost")

    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        fail(f"输入 JSON 无效: {error}")

    endpoint = str(payload.get("endpoint") or "").rstrip("/")
    args = payload.get("args")
    output_value = str(payload.get("outputPath") or "")

    if not endpoint:
        fail("缺少 GPT-SoVITS Gradio 地址")
    if not isinstance(args, list) or len(args) < 17:
        fail("GPT-SoVITS Gradio 参数列表无效")
    if not output_value:
        fail("缺少输出路径")
    output_path = Path(output_value).resolve()

    try:
        from gradio_client import Client, file

        with tempfile.TemporaryDirectory(prefix="dialogue-bridge-gradio-") as temp:
            staging = Path(temp)
            call_args = list(args)
            call_args[0] = file(
                str(stage_file(str(call_args[0]), staging, "primary"))
            )
            auxiliary_paths = call_args[12] or []
            if not isinstance(auxiliary_paths, list):
                raise ValueError("辅助参考音频参数必须是列表")
            call_args[12] = [
                file(str(stage_file(str(item), staging, f"aux-{index}")))
                for index, item in enumerate(auxiliary_paths, start=1)
            ] or None

            client = Client(endpoint, verbose=False)
            result = client.predict(*call_args, api_name="/get_tts_wav")
            source = Path(output_path_from_result(result)).resolve()
            if not source.exists():
                fail(f"GPT-SoVITS 返回的音频不存在: {source}")
            output_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, output_path)

        print(
            json.dumps(
                {
                    "ok": True,
                    "source": str(source),
                    "outputPath": str(output_path),
                },
                ensure_ascii=False,
            )
        )
    except Exception as error:  # noqa: BLE001 - user-facing helper boundary
        print(traceback.format_exc(), file=sys.stderr)
        fail(f"{type(error).__name__}: {error}")


if __name__ == "__main__":
    main()
