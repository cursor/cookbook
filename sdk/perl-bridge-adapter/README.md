# Perl SDK Bridge adapter

A miniature Cursor SDK written in Perl, talking to the open [`sdk.v1` bridge](https://github.com/cursor/sdk-bridge) over Connect JSON. No CPAN modules: Perl 5.14+ core only (`HTTP::Tiny`, `JSON::PP`).

This is a teaching example for building an adapter in a language without a first-party SDK. It is not a supported product SDK. Prefer [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk) or [`cursor-sdk`](https://pypi.org/project/cursor-sdk/) when you can.

```perl
use CursorSdk qw(prompt);

print prompt(
    "Summarize this repository.",
    cwd => "/path/to/repo",
);
```

Or stream one turn yourself:

```perl
my $client = CursorSdk::Client->new(workspace => ".");
my $agent  = $client->create_agent(cwd => ".");
my $run    = $agent->send("Explain this project in one paragraph.");
print for $run->iter_text;
$run->wait;
$agent->close;
$client->shutdown;
```

## Layout

| File | Role |
| :--- | :--- |
| `lib/CursorSdk.pm` | Bridge manager, Connect JSON transport, `Client` / `Agent` / `Run` |
| `demo.pl` | One local agent turn, same shape as the TypeScript quickstart |

## Getting started

Perl 5.14+ and Python 3.10+ (for the bridge binary inside `cursor-sdk`).

```bash
python3 -m venv .venv
.venv/bin/pip install cursor-sdk
export CURSOR_SDK_BRIDGE_BIN="$(.venv/bin/python -c 'from cursor_sdk._vendor import resolve_bridge_path; print(resolve_bridge_path())')"

chmod +x demo.pl
```

Set a Cursor API key from the [dashboard](https://cursor.com/dashboard/integrations), then run a turn against the cookbook repo:

```bash
export CURSOR_API_KEY="crsr_..."
./demo.pl
```

Optional environment:

| Variable | Meaning |
| :--- | :--- |
| `CURSOR_WORKSPACE` | Local agent cwd (default: cookbook repo root) |
| `CURSOR_PROMPT` | Prompt to send |
| `CURSOR_MODEL` | Model id; otherwise the first catalog entry |
| `CURSOR_SDK_BRIDGE_BIN` | Path to `cursor-sdk-bridge` (required unless `./cursor-sdk-bridge/bin/cursor-sdk-bridge` exists) |

## Notes

- The bridge speaks HTTP/1.1 Connect only. Classic gRPC clients will not connect.
- This adapter uses JSON (`application/json` and `application/connect+json`) instead of protobuf codegen so the wire format stays visible.
- Use the bridge from the `cursor-sdk` wheel. The GitHub standalone archive can ping, but local `CreateAgent` currently returns an internal 500.
- Protocol details and the adapter build guide live in [`cursor/sdk-bridge`](https://github.com/cursor/sdk-bridge).
- See also the [SDK Bridge docs](https://cursor.com/docs/sdk/bridge).
