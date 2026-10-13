"""HTTP transport for the speech API that survives a broken IPv6 route.

Some networks (phone tethering, some ISPs) advertise an IPv6 default route
that does not actually reach the internet. Browsers race IPv4 and IPv6
("Happy Eyeballs"); httpx tries every resolved address in turn, waiting the
full connect timeout on each, so a transcription stalled for about a minute.

FallbackTransport tries its routes in order and moves on only when a
connection could not be made, i.e. before any request bytes were sent, so
switching routes never uploads a command twice (the OpenAI SDK's own single
retry after a timeout or server error still can). The route that worked is
tried first next time.

A custom transport makes httpx ignore proxy environment variables, so behind a
proxy the client keeps httpx's own proxy handling instead (see uses_proxy).
"""

from __future__ import annotations

import threading
import urllib.request

import httpx2

CONNECT_ERRORS = (httpx2.ConnectError, httpx2.ConnectTimeout)


class FallbackTransport(httpx2.BaseTransport):
    def __init__(self, routes: list[httpx2.BaseTransport]) -> None:
        if not routes:
            raise ValueError("FallbackTransport needs at least one route")
        self._routes = list(routes)
        self._lock = threading.Lock()  # two transcriptions may run at once

    def handle_request(self, request: httpx2.Request) -> httpx2.Response:
        with self._lock:
            routes = list(self._routes)
        for route in routes:
            try:
                response = route.handle_request(request)
            except CONNECT_ERRORS as exc:
                error = exc
                continue
            self._prefer(route)
            return response
        raise error

    def _prefer(self, route: httpx2.BaseTransport) -> None:
        with self._lock:
            self._routes = [route, *(r for r in self._routes if r is not route)]

    def close(self) -> None:
        for route in self._routes:
            route.close()


def uses_proxy() -> bool:
    """True when the environment routes HTTPS through a proxy (HTTPS_PROXY, ALL_PROXY, ...)."""
    proxies = urllib.request.getproxies()
    return bool(proxies.get("https") or proxies.get("all"))


def default_routes() -> list[httpx2.BaseTransport]:
    """IPv4 first (binding 0.0.0.0 skips IPv6 addresses), then any address family.

    On an IPv6-only network the IPv4 route fails at once (no route), so the
    second one is used without delay.
    """
    return [httpx2.HTTPTransport(local_address="0.0.0.0"), httpx2.HTTPTransport()]
