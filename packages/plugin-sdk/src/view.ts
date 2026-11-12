// Views: trees a plugin sends, which the app draws with its own components, so that a plugin's
// screen looks like Zuna and follows the theme. GPUI is compiled into the app, so a plugin never
// hands it elements: it describes them, and the app compares by key and draws again. A handler
// is a function here, and a number on the way to the app, which calls back with it.
//
//   <column gap="m">
//     <heading>Messages today</heading>
//     <button onClick={() => reset()}>Reset</button>
//   </column>

/** A color: one of the theme's tokens, or the plugin's own, inside its own view. */
export type Color = "text1" | "text2" | "text3" | "accent" | "accentText" | "green" | "red" | "amber" | "bg1" | "bg2" | "bg3" | `#${string}`;
export type Space = "none" | "xs" | "s" | "m" | "l" | "xl";
/** A Lucide icon among those the app carries, by its name, such as `languages` or `sparkles`. */
export type IconName = string;

interface Box {
  key?: string | number;
  gap?: Space;
  padding?: Space;
  align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "between";
  grow?: boolean;
  background?: Color;
  rounded?: boolean;
}

export interface Shape {
  kind: "rect" | "circle" | "line" | "text";
  x: number;
  y: number;
  width?: number;
  height?: number;
  radius?: number;
  x2?: number;
  y2?: number;
  text?: string;
  size?: number;
  color?: Color;
  fill?: boolean;
}

/** What the nodes take, by name: what JSX checks a view against. */
export interface Nodes {
  column: Box & { children?: Child };
  row: Box & { wrap?: boolean; children?: Child };
  stack: Box & { children?: Child };
  scroll: Box & { height?: number; children?: Child };
  list: Box & { height?: number; children?: Child };
  text: { key?: string | number; size?: "s" | "m" | "l" | "xl"; weight?: "normal" | "medium" | "bold"; color?: Color; mono?: boolean; children?: Child };
  heading: { key?: string | number; children?: Child };
  markup: { key?: string | number; text: string };
  button: { key?: string | number; kind?: "default" | "primary" | "danger" | "ghost"; icon?: IconName; disabled?: boolean; onClick?: () => void; children?: Child };
  iconButton: { key?: string | number; icon: IconName; title?: string; active?: boolean; onClick?: () => void };
  switch: { key?: string | number; value: boolean; onChange?: (value: boolean) => void };
  slider: { key?: string | number; value: number; onChange?: (value: number) => void };
  select: { key?: string | number; value: string; options: (string | { value: string; label: string })[]; onChange?: (value: string) => void };
  input: { key?: string | number; value?: string; placeholder?: string; multiline?: boolean; masked?: boolean; onChange?: (value: string) => void; onSubmit?: (value: string) => void };
  field: { key?: string | number; label: string; hint?: string; children?: Child };
  notice: { key?: string | number; icon?: IconName; tone?: "info" | "warning" | "danger"; children?: Child };
  image: { key?: string | number; src: string; width?: number; height?: number; rounded?: boolean };
  avatar: { key?: string | number; name: string; seed?: string; size?: number };
  icon: { key?: string | number; name: IconName; size?: number; color?: Color };
  divider: { key?: string | number };
  spacer: { key?: string | number };
  spinner: { key?: string | number; size?: number };
  canvas: { key?: string | number; width: number; height: number; shapes: Shape[] };
}

export type NodeType = keyof Nodes;

/** A node as it's sent: its type, its props, and its children. */
export interface ViewNode {
  type: NodeType | "fragment" | "string";
  props: Record<string, unknown>;
  children: ViewNode[];
}

export type Child = ViewNode | string | number | boolean | null | undefined | Child[];

function flatten(children: Child[], out: ViewNode[]): ViewNode[] {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) flatten(child, out);
    else if (typeof child === "string" || typeof child === "number") out.push({ type: "string", props: { text: String(child) }, children: [] });
    else if (child.type === "fragment") out.push(...child.children);
    else out.push(child);
  }
  return out;
}

/** Fragment: children with nothing around them. */
export const Fragment = "fragment" as const;

/** The JSX factory: `h("button", { onClick }, "Reset")`, or written as JSX. */
export function h<T extends NodeType>(type: T | typeof Fragment | ((props: any) => ViewNode), props: (Nodes[T] & { children?: Child }) | null, ...children: Child[]): ViewNode {
  if (typeof type === "function") return type({ ...(props ?? {}), children });
  const { children: inline, ...rest } = (props ?? {}) as Record<string, unknown>;
  const all = children.length > 0 ? children : inline === undefined ? [] : [inline as Child];
  return { type, props: rest, children: flatten(all, []) };
}

/** What a view is drawn from: the plugin's storage as it is now. */
export type Render = (state: Readonly<Record<string, unknown>>) => ViewNode;

// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace h.JSX {
  type Element = ViewNode;
  type IntrinsicElements = { [K in NodeType]: Nodes[K] };
  interface ElementChildrenAttribute {
    children: {};
  }
}
