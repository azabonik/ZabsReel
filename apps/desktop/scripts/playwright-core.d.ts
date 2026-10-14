// The slice of playwright-core the scripts use (parity-gl.mts, smoke-electron.mts, and
// packages/core/scripts/smoke-voicefx.ts). playwright-core is not a dependency: the scripts load
// it at run time from PLAYWRIGHT_CORE or the npx cache, so its own types are not installed.
// Declare only what the scripts call; add a member here when a script starts using it.
declare module "playwright-core" {
  export interface ConsoleMessage {
    type(): string;
    text(): string;
  }
  export interface Dialog {
    message(): string;
    accept(): Promise<void>;
  }
  export interface Request {
    url(): string;
    resourceType(): string;
  }
  export interface Response {
    url(): string;
    status(): number;
  }
  export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
  }
  export interface RoleOptions {
    name?: string | RegExp;
    exact?: boolean;
  }
  export interface Locator {
    first(): Locator;
    count(): Promise<number>;
    innerText(): Promise<string>;
    allInnerTexts(): Promise<string[]>;
    inputValue(): Promise<string>;
    focus(): Promise<void>;
    click(options?: { position?: { x: number; y: number } }): Promise<void>;
    isEnabled(): Promise<boolean>;
    boundingBox(): Promise<Box | null>;
    getByRole(role: string, options?: RoleOptions): Locator;
    evaluate<R>(pageFunction: (element: Element) => R | Promise<R>): Promise<R>;
    dispatchEvent(type: string, eventInit?: Record<string, unknown>): Promise<void>;
  }
  export interface Page {
    on(event: "console", listener: (message: ConsoleMessage) => void): Page;
    on(event: "pageerror", listener: (error: Error) => void): Page;
    on(event: "dialog", listener: (dialog: Dialog) => void): Page;
    on(event: "request", listener: (request: Request) => void): Page;
    on(event: "response", listener: (response: Response) => void): Page;
    goto(url: string): Promise<unknown>;
    title(): Promise<string>;
    // A string is evaluated as an expression in the page; its result is unknown here.
    evaluate<R>(pageFunction: string | (() => R | Promise<R>)): Promise<R>;
    evaluate<R, Arg>(pageFunction: (arg: Arg) => R | Promise<R>, arg: Arg): Promise<R>;
    locator(selector: string, options?: { hasText?: string | RegExp }): Locator;
    getByRole(role: string, options?: RoleOptions): Locator;
    mouse: { move(x: number, y: number, options?: { steps?: number }): Promise<void>; down(): Promise<void>; up(): Promise<void> };
    keyboard: { press(key: string): Promise<void>; down(key: string): Promise<void>; up(key: string): Promise<void> };
    isClosed(): boolean;
    close(): Promise<void>;
  }
  export interface Browser {
    newPage(): Promise<Page>;
    version(): string;
    close(): Promise<void>;
  }
  export interface ElectronApplication {
    process(): import("node:child_process").ChildProcess;
    firstWindow(options?: { timeout?: number }): Promise<Page>;
    evaluate<R>(fn: (electron: typeof import("electron")) => R | Promise<R>): Promise<R>;
    evaluate<R, Arg>(fn: (electron: typeof import("electron"), arg: Arg) => R | Promise<R>, arg: Arg): Promise<R>;
    once(event: "close", listener: () => void): ElectronApplication;
    close(): Promise<void>;
  }
  export const chromium: {
    launch(options?: { executablePath?: string; headless?: boolean; args?: string[] }): Promise<Browser>;
  };
  export const _electron: {
    launch(options: { executablePath: string; args?: string[]; cwd?: string; env?: Record<string, string>; timeout?: number }): Promise<ElectronApplication>;
  };
}
