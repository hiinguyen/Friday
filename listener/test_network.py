"""Tests for the HTTP transport that survives a broken IPv6 route."""

from __future__ import annotations

import time

import httpx2
import pytest

import network

URL = "https://api.example.com/v1/audio/transcriptions"


class Route(httpx2.BaseTransport):
    """A fake network path: answers, or fails like an unreachable route."""

    def __init__(self, name: str, error: Exception | None = None) -> None:
        self.name, self.error, self.calls = name, error, 0

    def handle_request(self, request: httpx2.Request) -> httpx2.Response:
        self.calls += 1
        if self.error:
            raise self.error
        return httpx2.Response(200, text=self.name, request=request)


def get(transport: httpx2.BaseTransport) -> str:
    with httpx2.Client(transport=transport) as client:
        return client.get(URL).text


def test_falls_back_when_a_route_cannot_connect() -> None:
    """Broken IPv6: connecting hangs or fails, the other route answers."""
    broken = Route("broken", httpx2.ConnectTimeout("timed out"))
    working = Route("working")
    assert get(network.FallbackTransport([broken, working])) == "working"


def test_remembers_the_route_that_worked() -> None:
    broken = Route("broken", httpx2.ConnectError("network unreachable"))
    working = Route("working")
    transport = network.FallbackTransport([broken, working])
    get(transport)
    get(transport)
    assert (broken.calls, working.calls) == (1, 2)


def test_raises_when_no_route_connects() -> None:
    transport = network.FallbackTransport(
        [Route("a", httpx2.ConnectError("a down")), Route("b", httpx2.ConnectTimeout("b down"))]
    )
    with pytest.raises(httpx2.ConnectTimeout, match="b down"):
        get(transport)


def test_does_not_resend_after_the_request_went_out() -> None:
    """A read timeout means the server may have the audio already: never send it twice."""
    slow = Route("slow", httpx2.ReadTimeout("no answer"))
    other = Route("other")
    with pytest.raises(httpx2.ReadTimeout):
        get(network.FallbackTransport([slow, other]))
    assert other.calls == 0


def test_concurrent_requests_share_the_route_preference_safely() -> None:
    """Two transcriptions can run at once (two worker threads); reordering routes must not race."""
    from concurrent.futures import ThreadPoolExecutor

    class Slow(Route):
        def handle_request(self, request: httpx2.Request) -> httpx2.Response:
            time.sleep(0.001)
            return super().handle_request(request)

    broken, working = Route("broken", httpx2.ConnectError("unreachable")), Slow("working")
    transport = network.FallbackTransport([broken, working])
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _i: get(transport), range(200)))
    assert set(results) == {"working"}


def test_proxy_settings_are_detected(monkeypatch) -> None:
    for name in ("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.delenv(name, raising=False)
    assert not network.uses_proxy()
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.local:3128")
    assert network.uses_proxy()


def test_default_routes_prefer_ipv4_then_any_family() -> None:
    first, second = network.default_routes()
    assert first._pool._local_address == "0.0.0.0"
    assert second._pool._local_address is None
