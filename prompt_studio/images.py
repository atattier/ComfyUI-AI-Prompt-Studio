"""Image input handling shared by the standalone backend and the ComfyUI routes."""

from __future__ import annotations

import base64
from typing import Any

from .client import image_part_from_url
from .errors import InvalidRequestError
from .sessions import MediaStore, decode_data_url


def image_to_part(media: MediaStore, image: Any) -> dict[str, Any]:
    """Convert a frontend image descriptor into an OpenAI content part.

    Accepted shapes::

        {"url": "https://..."}
        {"data_url": "data:image/png;base64,..."}
        {"base64": "...", "mime": "image/png"}
    """
    if not isinstance(image, dict):
        raise InvalidRequestError("each image must be an object.")
    if image.get("url"):
        url = str(image["url"])
        if not url.lower().startswith(("http://", "https://")):
            raise InvalidRequestError("image url must be http(s).")
        return image_part_from_url(url)
    try:
        if image.get("data_url"):
            data, mime = decode_data_url(str(image["data_url"]))
            return media.put(data, mime)
        if image.get("base64"):
            try:
                data = base64.b64decode(str(image["base64"]), validate=True)
            except Exception as exc:  # noqa: BLE001
                raise InvalidRequestError("image base64 is invalid.") from exc
            mime = str(image.get("mime") or "image/png")
            return media.put(data, mime)
    except ValueError as exc:
        raise InvalidRequestError(f"Image rejected: {exc}") from exc
    raise InvalidRequestError("image needs url, data_url or base64.")


def to_api_part(media: MediaStore, part: dict[str, Any]) -> dict[str, Any]:
    """Resolve one stored part into something the model API accepts."""
    if isinstance(part, dict) and part.get("type") == "image_ref":
        return media.to_api_part(part) or part
    return part


def resolve_for_api(media: MediaStore, parts: list[Any]) -> list[dict[str, Any]]:
    """Resolve stored image refs into data URLs for a follow-up model call."""
    out: list[dict[str, Any]] = []
    for part in parts:
        if isinstance(part, dict) and part.get("type") == "image_ref":
            resolved = media.to_api_part(part)
            if resolved is not None:
                out.append(resolved)
        elif isinstance(part, dict):
            out.append(part)
    return out
