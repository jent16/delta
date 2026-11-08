// Types for motion-math.js so the unit tests (TypeScript) can import it. The browser never sees this file.
export const DURATION: Record<"swap" | "dropdown" | "modal" | "screen" | "toast" | "move" | "drawer", number>;
export const EXIT_FACTOR: number;
export function exitDuration(enterMs: number): number;
export const EASE: Record<"out" | "inOut" | "in", string>;
export const SCALE: { popover: number; press: number };
export const STRETCH: number;
export const STAGGER: { step: number; max: number };
export function staggerDelay(index: number, options?: { step: number; max: number }): number | null;
export function rubberBand(distance: number, limit?: number, resistance?: number): number;
export function originFor(trigger: { left: number; top: number; width: number; height: number }, panel: { left: number; top: number }): { x: number; y: number };
export function arcPoints(from: { x: number; y: number }, steps?: number, lift?: number): { x: number; y: number }[];
export function arcKeyframes(from: { x: number; y: number }, fromScale?: number, steps?: number): { transform: string; offset: number }[];
export function knobKeyframes(prev: { x: number; w: number }, next: { x: number; w: number }): { transform: string; offset: number }[];
