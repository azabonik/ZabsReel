import "./helpers/dom";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { useCurrentFrame, useDelayRender, useVideoConfig } from "../runtime/src/index";
import {
  makeHost,
  moduleFor,
  mount,
  rejectsWithCode,
  throwsCode,
  tick,
  ticks,
  track,
} from "./helpers/host";

function FrameText() {
  return <span>{useCurrentFrame()}</span>;
}

test("renderFrame commits the frame synchronously, before the promise settles", async () => {
  const m = mount(makeHost(), FrameText);
  const pending = m.app.renderFrame(5);
  assert.equal(m.container.textContent, "5");
  assert.deepEqual(await pending, { cues: [] });
  const second = m.app.renderFrame(42);
  assert.equal(m.container.textContent, "42");
  await second;
  m.app.unmount();
});

test("frames can be rendered in any order and repeated", async () => {
  const m = mount(makeHost(), FrameText);
  for (const n of [10, 3, 3, 299, 0]) {
    await m.app.renderFrame(n);
    assert.equal(m.container.textContent, String(n));
  }
  m.app.unmount();
});

test("the runtime renders into one root element that fills the container; the container keeps its size", async () => {
  const m = mount(makeHost(), FrameText);
  await m.app.renderFrame(0);
  assert.equal(m.container.children.length, 1);
  const root = m.container.firstElementChild as HTMLElement;
  assert.equal(root.style.position, "relative");
  assert.equal(root.style.overflow, "hidden");
  assert.equal(root.style.width, "100%");
  assert.equal(root.style.height, "100%");
  assert.equal(m.container.style.width, "1280px");
  assert.equal(m.container.style.height, "720px");
  m.app.unmount();
});

test("the component receives composition.props", async () => {
  let seen: Record<string, unknown> | null = null;
  const m = mount(makeHost({ composition: { props: { title: "Hello", count: 3 } } }), (props) => {
    seen = props;
    return null;
  });
  await m.app.renderFrame(0);
  assert.deepEqual(seen, { title: "Hello", count: 3 });
  m.app.unmount();
});

test("useVideoConfig returns exactly the documented fields", async () => {
  let config: unknown;
  const props = { a: 1 };
  const m = mount(makeHost({ composition: { props, width: 1920, height: 1080, fps: 25, durationInFrames: 120 } }), () => {
    config = useVideoConfig();
    return null;
  });
  await m.app.renderFrame(0);
  assert.deepEqual(config, {
    id: "Graphic",
    width: 1920,
    height: 1080,
    fps: 25,
    durationInFrames: 120,
    props,
    defaultProps: props,
    defaultCodec: null,
    defaultSampleRate: 48000,
  });
  const c = config as { props: unknown; defaultProps: unknown };
  assert.equal(c.props, props);
  assert.equal(c.defaultProps, props);
  m.app.unmount();
});

// ---- Settling ----

test("settle: a delay opened in an effect holds the frame; setState then continueRender shows the new state", async () => {
  function Loader() {
    const { delayRender, continueRender } = useDelayRender();
    const [handle] = React.useState(() => delayRender("fetch"));
    const [data, setData] = React.useState("none");
    React.useEffect(() => {
      Promise.resolve().then(() => {
        setData("loaded");
        continueRender(handle);
      });
    }, [handle, continueRender]);
    return <span>{data}</span>;
  }
  const m = mount(makeHost(), Loader);
  const result = await m.app.renderFrame(0);
  assert.deepEqual(result, { cues: [] });
  assert.equal(m.container.textContent, "loaded");
  m.app.unmount();
});

test("settle: delays opened by the updated state's effects count too", async () => {
  let releaseSecond: (() => void) | null = null;
  function Chain() {
    const { delayRender, continueRender } = useDelayRender();
    const [handle] = React.useState(() => delayRender("first"));
    const [step, setStep] = React.useState(0);
    React.useEffect(() => {
      Promise.resolve().then(() => {
        setStep(1);
        continueRender(handle);
      });
    }, [handle, continueRender]);
    React.useEffect(() => {
      if (step !== 1) return;
      const second = delayRender("second");
      releaseSecond = () => {
        setStep(2);
        continueRender(second);
      };
    }, [step, delayRender, continueRender]);
    return <span>{step}</span>;
  }
  const m = mount(makeHost(), Chain);
  const t = track(m.app.renderFrame(0));
  await ticks(10);
  assert.equal(t.settled(), false, "must wait for the second delay");
  assert.ok(releaseSecond);
  (releaseSecond as () => void)();
  await t.promise;
  assert.equal(m.container.textContent, "2");
  m.app.unmount();
});

test("settle: state set in a passive effect (no delay at all) is committed before the frame settles", async () => {
  function Doubler() {
    const frame = useCurrentFrame();
    const [value, setValue] = React.useState(-1);
    React.useEffect(() => setValue(frame * 2), [frame]);
    return <span>{value}</span>;
  }
  const m = mount(makeHost(), Doubler);
  await m.app.renderFrame(4);
  assert.equal(m.container.textContent, "8");
  await m.app.renderFrame(7);
  assert.equal(m.container.textContent, "14");
  m.app.unmount();
});

test("settle: chains of effect updates are committed before the frame settles", async () => {
  function Counter() {
    const [n, setN] = React.useState(0);
    React.useEffect(() => {
      if (n < 5) setN(n + 1);
    }, [n]);
    return <span>{n}</span>;
  }
  const m = mount(makeHost(), Counter);
  await m.app.renderFrame(0);
  assert.equal(m.container.textContent, "5");
  m.app.unmount();
});

test("settle: a transition update scheduled before continueRender is committed", async () => {
  function Transitioned() {
    const { delayRender, continueRender } = useDelayRender();
    const [handle] = React.useState(() => delayRender("transition"));
    const [text, setText] = React.useState("old");
    React.useEffect(() => {
      Promise.resolve().then(() => {
        React.startTransition(() => setText("new"));
        continueRender(handle);
      });
    }, [handle, continueRender]);
    return <span>{text}</span>;
  }
  const m = mount(makeHost(), Transitioned);
  await m.app.renderFrame(0);
  assert.equal(m.container.textContent, "new");
  m.app.unmount();
});

test("settle: a component whose effect opens and closes a delay on every render does not loop", async () => {
  function OpenClose() {
    const { delayRender, continueRender } = useDelayRender();
    React.useEffect(() => {
      const h = delayRender("quick");
      continueRender(h);
    });
    return <span>{useCurrentFrame()}</span>;
  }
  const m = mount(makeHost(), OpenClose);
  await m.app.renderFrame(3);
  assert.equal(m.container.textContent, "3");
  m.app.unmount();
});

// ---- Timeouts and rejections ----

test("timeout: a delay that is never released rejects with graphic_frame_timeout naming its label", async () => {
  function Stuck() {
    const { delayRender } = useDelayRender();
    React.useState(() => delayRender("waiting-for-godot"));
    return null;
  }
  const m = mount(makeHost({ frameTimeoutMs: 60 }), Stuck);
  const error = await rejectsWithCode(m.app.renderFrame(0), "graphic_frame_timeout");
  assert.match(error.message, /waiting-for-godot/);
  m.app.unmount();
});

test("timeout: counts from the renderFrame call and is the only deadline (delay options are ignored)", async () => {
  let release: (() => void) | null = null;
  function SlowButFine() {
    const { delayRender, continueRender } = useDelayRender();
    React.useState(() => {
      const h = delayRender("slow", { timeoutInMilliseconds: 1, retries: 3 });
      release = () => continueRender(h);
      return h;
    });
    return null;
  }
  const m = mount(makeHost({ frameTimeoutMs: 300 }), SlowButFine);
  const t = track(m.app.renderFrame(0));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(t.settled(), false);
  (release as unknown as () => void)();
  assert.deepEqual(await t.promise, { cues: [] });
  m.app.unmount();
});

test("after a rejection every later renderFrame rejects with the same error", async () => {
  const boom = new Error("boom");
  function Throws() {
    if (useCurrentFrame() === 2) throw boom;
    return null;
  }
  const m = mount(makeHost(), Throws);
  await m.app.renderFrame(1);
  await assert.rejects(m.app.renderFrame(2), (e) => e === boom);
  await assert.rejects(m.app.renderFrame(1), (e) => e === boom);
  await assert.rejects(m.app.renderFrame(0), (e) => e === boom);
  m.app.unmount();
});

test("user render errors pass through unchanged, with their code", async () => {
  const coded = Object.assign(new Error("custom"), { code: "my_code" });
  const m = mount(makeHost(), () => {
    throw coded;
  });
  await assert.rejects(m.app.renderFrame(0), (e) => e === coded && (e as { code?: string }).code === "my_code");
  m.app.unmount();
});

test("a thrown value that is not an Error is wrapped in an Error that keeps it as cause", async () => {
  const m = mount(makeHost(), () => {
    throw "plain string";
  });
  let caught: unknown;
  await m.app.renderFrame(0).catch((e) => {
    caught = e;
  });
  assert.ok(caught instanceof Error);
  assert.equal((caught as Error).cause, "plain string");
  assert.match((caught as Error).message, /plain string/);
  assert.equal((caught as { code?: unknown }).code, undefined, "recorded choice: the wrapper has no code");
  m.app.unmount();
});

test("errors thrown in effects reject the frame", async () => {
  const failure = new Error("effect failed");
  function BadEffect() {
    React.useEffect(() => {
      throw failure;
    });
    return null;
  }
  const m = mount(makeHost(), BadEffect);
  await assert.rejects(m.app.renderFrame(0), (e) => e === failure);
  m.app.unmount();
});

test("errors in the user's own async code are not caught: the frame times out", async () => {
  function AsyncThrow() {
    const { delayRender } = useDelayRender();
    React.useState(() => delayRender("async"));
    React.useEffect(() => {
      Promise.resolve()
        .then(() => {
          throw new Error("lost");
        })
        .catch(() => undefined);
    }, []);
    return null;
  }
  const m = mount(makeHost({ frameTimeoutMs: 50 }), AsyncThrow);
  await rejectsWithCode(m.app.renderFrame(0), "graphic_frame_timeout");
  m.app.unmount();
});

test("an error that happens while no renderFrame is pending is kept for the next one", async () => {
  let later: (() => void) | null = null;
  function Later() {
    const { cancelRender } = useDelayRender();
    later = () => {
      try {
        cancelRender("gave up between frames");
      } catch {
        // The user catches the throw; the next frame still rejects.
      }
    };
    return null;
  }
  const m = mount(makeHost(), Later);
  await m.app.renderFrame(0);
  (later as unknown as () => void)();
  const error = await rejectsWithCode(m.app.renderFrame(1), "graphic_render_cancelled");
  assert.equal(error.message, "gave up between frames");
  m.app.unmount();
});

// ---- cancelRender ----

test("cancelRender(string): rejects the pending frame with graphic_render_cancelled and the reason as message", async () => {
  function Cancels() {
    const { cancelRender, delayRender } = useDelayRender();
    React.useState(() => delayRender("never released"));
    React.useEffect(() => {
      Promise.resolve().then(() => {
        try {
          cancelRender("network down");
        } catch {
          // caught by user code
        }
      });
    }, [cancelRender]);
    return null;
  }
  const m = mount(makeHost({ frameTimeoutMs: 2000 }), Cancels);
  const error = await rejectsWithCode(m.app.renderFrame(0), "graphic_render_cancelled");
  assert.equal(error.message, "network down");
  m.app.unmount();
});

test("cancelRender(Error): message is the Error's message and cause is the Error", async () => {
  const reason = new Error("disk full");
  let thrown: unknown;
  function Cancels() {
    const { cancelRender } = useDelayRender();
    React.useEffect(() => {
      try {
        cancelRender(reason);
      } catch (e) {
        thrown = e;
      }
    }, [cancelRender]);
    return null;
  }
  const m = mount(makeHost(), Cancels);
  const error = await rejectsWithCode(m.app.renderFrame(0), "graphic_render_cancelled");
  assert.equal(error.message, "disk full");
  assert.equal(error.cause, reason);
  assert.equal(thrown, error, "cancelRender throws the same error the frame rejects with");
  m.app.unmount();
});

test("cancelRender releases every open delay", async () => {
  const host = makeHost();
  const mod = moduleFor(host);
  mod.delayRender("one");
  mod.delayRender("two");
  const m = mount(host, () => null);
  throwsCode(() => mod.cancelRender("stop"), "graphic_render_cancelled");
  // Delays are gone: the rejection is the cancel error, not a timeout.
  const error = await rejectsWithCode(m.app.renderFrame(0), "graphic_render_cancelled");
  assert.equal(error.message, "stop");
  m.app.unmount();
});

test("recorded choice: cancelRender with a non-string, non-Error reason uses String(reason) and keeps it as cause", async () => {
  const host = makeHost();
  const mod = moduleFor(host);
  const m = mount(host, () => null);
  const error = throwsCode(() => mod.cancelRender(404), "graphic_render_cancelled");
  assert.equal(error.message, "404");
  assert.equal(error.cause, 404);
  m.app.unmount();
});

test("a later cancelRender does not replace the first rejection", async () => {
  const host = makeHost();
  const mod = moduleFor(host);
  const m = mount(host, () => null);
  throwsCode(() => mod.cancelRender("first"), "graphic_render_cancelled");
  throwsCode(() => mod.cancelRender("second"), "graphic_render_cancelled");
  const error = await rejectsWithCode(m.app.renderFrame(0), "graphic_render_cancelled");
  assert.equal(error.message, "first");
  m.app.unmount();
});

// ---- unmount ----

test("unmount rejects a pending renderFrame and every later one with graphic_render_cancelled", async () => {
  function Stuck() {
    const { delayRender } = useDelayRender();
    React.useState(() => delayRender("forever"));
    return null;
  }
  const m = mount(makeHost({ frameTimeoutMs: 5000 }), Stuck);
  const pending = m.app.renderFrame(0);
  await tick();
  m.app.unmount();
  await rejectsWithCode(pending, "graphic_render_cancelled");
  await rejectsWithCode(m.app.renderFrame(1), "graphic_render_cancelled");
  assert.equal(m.container.children.length, 0, "the root element is removed");
  m.app.unmount(); // a second call does nothing
  await rejectsWithCode(m.app.renderFrame(1), "graphic_render_cancelled");
});

test("unmount takes precedence over an earlier error", async () => {
  const m = mount(makeHost(), () => {
    throw new Error("broken");
  });
  await assert.rejects(m.app.renderFrame(0), /broken/);
  m.app.unmount();
  await rejectsWithCode(m.app.renderFrame(0), "graphic_render_cancelled");
});

// ---- Host binding ----

test("delays opened while the module is evaluated belong to the app and hold its first frame", async () => {
  const host = makeHost();
  const mod = moduleFor(host);
  const handle = mod.delayRender("top-level");
  const m = mount(host, FrameText);
  const t = track(m.app.renderFrame(0));
  await ticks(5);
  assert.equal(t.settled(), false);
  mod.continueRender(handle);
  await t.promise;
  m.app.unmount();
});

test("two apps in one page are independent", async () => {
  const hostA = makeHost({ frameTimeoutMs: 2000 });
  const hostB = makeHost();
  const modA = moduleFor(hostA);
  const handle = modA.delayRender("only A");
  const a = mount(hostA, FrameText);
  const b = mount(hostB, FrameText);
  const ta = track(a.app.renderFrame(1));
  await b.app.renderFrame(2);
  assert.equal(ta.settled(), false);
  assert.equal(b.container.textContent, "2");
  modA.continueRender(handle);
  await ta.promise;
  a.app.unmount();
  b.app.unmount();
});

test("useDelayRender returns stable functions bound to the app", async () => {
  const seen: unknown[] = [];
  const m = mount(makeHost(), () => {
    seen.push(useDelayRender());
    return <span>{useCurrentFrame()}</span>;
  });
  await m.app.renderFrame(0);
  await m.app.renderFrame(1);
  assert.ok(seen.length >= 2);
  assert.ok(seen.every((s) => s === seen[0]));
  m.app.unmount();
});

test("recorded choice: continueRender with a value that is not one of this app's handles throws graphic_api_misuse", async () => {
  const hostA = makeHost();
  const hostB = makeHost();
  const modA = moduleFor(hostA);
  const modB = moduleFor(hostB);
  const handle = modA.delayRender();
  throwsCode(() => modB.continueRender(handle), "graphic_api_misuse");
  throwsCode(() => modA.continueRender(undefined), "graphic_api_misuse");
  throwsCode(() => modA.continueRender("1"), "graphic_api_misuse");
  assert.equal(modA.continueRender(handle), undefined);
  modA.continueRender(handle); // releasing twice is harmless
});

test("recorded choice: delayRender with a label that is not a string throws graphic_api_misuse", () => {
  const mod = moduleFor(makeHost());
  throwsCode(() => mod.delayRender({ timeoutInMilliseconds: 5 }), "graphic_api_misuse");
});

test("recorded choice: renderFrame with a frame outside 0..durationInFrames-1 or not a whole number rejects with graphic_api_misuse", async () => {
  for (const bad of [-1, 300, 1.5, Number.NaN]) {
    const m = mount(makeHost(), FrameText);
    await rejectsWithCode(m.app.renderFrame(bad), "graphic_api_misuse");
    m.app.unmount();
  }
});

test("recorded choice: calling renderFrame again before the previous frame settled fails the app with graphic_api_misuse", async () => {
  function Stuck() {
    const { delayRender } = useDelayRender();
    React.useState(() => delayRender("hold"));
    return null;
  }
  const m = mount(makeHost({ frameTimeoutMs: 5000 }), Stuck);
  const first = m.app.renderFrame(0);
  await rejectsWithCode(m.app.renderFrame(1), "graphic_api_misuse");
  await rejectsWithCode(first, "graphic_api_misuse");
  m.app.unmount();
});

test("hooks used outside a ZedMix graphic throw graphic_api_misuse", () => {
  const { createRoot } = require("react-dom") as { createRoot(el: Element): { render(n: unknown): void; unmount(): void } };
  const { flushSync } = require("react-dom") as { flushSync(fn: () => void): void };
  const el = document.createElement("div");
  const root = createRoot(el);
  let caught: unknown;
  class Catch extends React.Component<{ children?: React.ReactNode }, { e: unknown }> {
    override state = { e: null as unknown };
    static getDerivedStateFromError(e: unknown) {
      return { e };
    }
    override componentDidCatch(e: unknown) {
      caught = e;
    }
    override render() {
      return this.state.e ? null : this.props.children;
    }
  }
  flushSync(() => root.render(<Catch><FrameText /></Catch>));
  assert.equal((caught as { code?: string }).code, "graphic_api_misuse");
  root.unmount();
});

test("createMotionApp rejects an invalid composition synchronously with graphic_api_misuse", () => {
  const host = makeHost({ composition: { fps: 0 } });
  throwsCode(() => mount(host, FrameText), "graphic_api_misuse");
});
