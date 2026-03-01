"""Autonomous jam loop — the model evolves the piece on a timer."""

from __future__ import annotations

import asyncio
from typing import Any

from rich.console import Console
from rich.panel import Panel
from rich.syntax import Syntax

from .config import Config
from .extractor import extract_code
from .mercury_client import MercuryClient
from .state import PieceState
from .tools import TOOL_DEFINITIONS, ToolDispatcher

JAM_PROMPT_TEMPLATE = """\
You are in JAM MODE. The genre/style is: {style}.

The piece currently playing is:
```
{current_piece}
```

Make {max_changes} small, deliberate changes to evolve this piece. Think like a live \
coder: tweak parameters, swap samples, add or remove a line, change an effect. \
Do NOT rewrite the whole piece — make targeted edits that shift the sound gradually.

If no piece is playing, start a new one in the {style} style.

Output the COMPLETE updated piece (not just the changes) in a ```mercury code block.
"""


async def jam_loop(
    cfg: Config,
    llm,
    mercury: MercuryClient,
    state: PieceState,
    system_prompt: str,
    style: str,
    console: Console,
    use_tools: bool,
) -> None:
    """Run the jam loop until cancelled."""
    dispatcher = ToolDispatcher(mercury, state)

    while True:
        await asyncio.sleep(cfg.jam_interval)

        try:
            current = state.read()
            jam_prompt = JAM_PROMPT_TEMPLATE.format(
                style=style,
                current_piece=current or "(nothing playing — start fresh)",
                max_changes=cfg.jam_max_changes,
            )

            messages: list[dict[str, Any]] = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": jam_prompt},
            ]
            tools = TOOL_DEFINITIONS if use_tools else None

            response = llm.chat(messages, tools=tools, stream=False)
            msg = response.get("message", {})
            content = msg.get("content", "")
            tool_calls = msg.get("tool_calls")

            code_sent = False

            if tool_calls:
                for tc in tool_calls:
                    result = dispatcher.dispatch(tc)
                    fn_name = tc.get("function", {}).get("name", "?")
                    console.print(f"  [dim]jam:tool:{fn_name} → {result}[/dim]")
                if dispatcher.last_code_sent:
                    _show_jam_code(console, dispatcher.last_code_sent)
                    code_sent = True

            if not code_sent and content:
                code = extract_code(content)
                if code:
                    mercury.send_code(code)
                    state.write(code)
                    _show_jam_code(console, code)

            console.print(f"[dim]jam: next evolution in {cfg.jam_interval}s[/dim]")

        except asyncio.CancelledError:
            raise
        except Exception as e:
            console.print(f"[error]jam error: {e}[/error]")


def _show_jam_code(console: Console, code: str) -> None:
    syntax = Syntax(code, "text", theme="monokai", line_numbers=True)
    console.print(Panel(syntax, title="Jam Evolution", border_style="magenta"))
