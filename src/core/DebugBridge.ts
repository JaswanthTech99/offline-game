/**
 * The automation bridge.
 *
 * Gates read STATE through this, never pixels. An earlier measurement pass inferred the
 * whole value structure from screenshots and got it wrong twice - once because it sampled
 * the canvas while half the image is the DOM `.fx` stack, and once because a max-luma read
 * centred on the aperture measured the aperture instead of the subject. State is not a
 * substitute for looking at the frame, but it is what an assertion should be built on.
 *
 * Nothing inside src/ reads this object. It is an outbound seam only.
 */

import type { PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import { Vector2 } from 'three/webgpu';

import type { Engine } from './Engine';
import type { QualityResolution, Tier } from './Quality';
import type { PostEffect } from './Quality';

/** Kinds a gate may ask the field to place in isolation. */
export type DebugPlaceKind = 'pane' | 'decorative' | 'crystal';

/** The corridor's built dimensions, in metres. Read by gates that derive sample points. */
export interface CorridorDims {
  readonly halfWidth: number;
  readonly halfHeight: number;
  readonly ringSpacing: number;
  readonly paneWidth: number;
  readonly paneHeight: number;
}

export interface DebugSnapshot {
  readonly ready: boolean;
  /** 'idle' | 'flash' | 'hitstop' | 'release' */
  readonly phase: string;
  readonly ballsLeft: number;
  readonly approach: number;
  readonly isTutorial: boolean;
  readonly travelSpeed: number;
  readonly paneCount: number;
  readonly crystalCount: number;
  readonly liveBalls: number;
  readonly liveShards: number;
  readonly drawCalls: number;
  readonly elementCount: number;
  readonly tier: Tier;
  readonly tierSource: 'detected' | 'override';
  readonly renderScale: number;
  readonly bufferWidth: number;
  readonly bufferHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly liveAA: readonly string[];
  /** Scene-pass buffer, i.e. what the 3D is actually drawn at before upscale. */
  readonly scenePassWidth: number;
  readonly scenePassHeight: number;
  readonly hardwareCeiling: number;
  readonly maxTextureSize: number;
  /** three's compiled-pipeline count. Must not grow after the first presented frame. */
  readonly pipelines: number;
  readonly score: number;
  readonly multiplier: number;
  readonly corridor: CorridorDims;
}

/** The subset of Playfield the bridge needs. Declared structurally to avoid a cycle. */
export interface DebugField {
  readonly shatterPhase: string;
  readonly corridorDims: CorridorDims;
  readonly balls_: number;
  readonly approach: number;
  readonly isTutorial: boolean;
  readonly travelSpeedNow: number;
  readonly paneCount: number;
  readonly crystalCount: number;
  readonly liveBalls: number;
  readonly liveShards: number;
  readonly shellElements: number;
  readonly scoreValue: number;
  readonly multiplierValue: number;
  throwAt(ndcX: number, ndcY: number): void;
  restart(): void;
  setViewportPx(px: number): void;
  testPlaceOnly(kind: DebugPlaceKind, distanceM: number, offsetX?: number): void;
  testShatter(): void;
  testStep(dtMs: number): void;
  testAdvanceTo(approach: number): void;
  testClearField(): void;
}

export interface DebugBridge {
  ready(): boolean;
  snapshot(): DebugSnapshot;
  /**
   * Stops every clock the renderer owns. Captures taken after this are byte-stable, which
   * is what makes a screenshot diff mean "something changed" rather than "time passed".
   */
  freeze(): void;
  unfreeze(): void;
  /** One deterministic fixed step. The only way to advance while frozen. */
  step(dtMs: number): void;
  place(kind: DebugPlaceKind, distanceM: number, offsetX?: number): void;
  clearField(): void;
  advanceTo(approach: number): void;
  throwAt(ndcX: number, ndcY: number): void;
  shatter(): void;
  restart(): void;
  /** Object-space position of the newest live ball, or null. Used by the visibility gate. */
  ballWorld(): { x: number; y: number; z: number } | null;
  /** Project a world point to CSS pixels, so a gate can look in the right place. */
  project(x: number, y: number, z: number): { x: number; y: number } | null;
}

export interface BridgeDeps {
  readonly engine: Engine;
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly field: DebugField;
  readonly quality: QualityResolution;
  readonly tierSource: 'detected' | 'override';
  readonly canvas: HTMLCanvasElement;
  readonly caps: { readonly maxTextureSize: number };
  /** Live post stages, so the bridge can report which AA actually built. */
  readonly builtStages: () => readonly PostEffect[];
  readonly ballWorld: () => { x: number; y: number; z: number } | null;
}

const AA_EFFECTS: readonly string[] = ['traa', 'taau', 'fsr1', 'smaa', 'fxaa'];

/** Reused, never allocated per snapshot: a gate may sample every frame. */
const scratchSize = new Vector2();

export function installDebugBridge(deps: BridgeDeps): DebugBridge {
  let frozen = false;

  const bridge: DebugBridge = {
    ready: () => window.__spReady === true,

    snapshot: () => {
      // A real Vector2: getDrawingBufferSize writes through target.set(), so a plain
      // object literal throws rather than being filled in.
      const size = deps.renderer.getDrawingBufferSize(scratchSize);
      let elements = 0;
      deps.scene.traverse((o) => {
        const inst = o as { isInstancedMesh?: boolean; isMesh?: boolean; count?: number };
        if (inst.isInstancedMesh === true) elements += inst.count ?? 0;
        else if (inst.isMesh === true) elements += 1;
      });
      return {
        ready: window.__spReady === true,
        phase: deps.field.shatterPhase,
        ballsLeft: deps.field.balls_,
        approach: deps.field.approach,
        isTutorial: deps.field.isTutorial,
        travelSpeed: deps.field.travelSpeedNow,
        paneCount: deps.field.paneCount,
        crystalCount: deps.field.crystalCount,
        liveBalls: deps.field.liveBalls,
        liveShards: deps.field.liveShards,
        drawCalls: deps.renderer.info.render.drawCalls,
        elementCount: elements,
        tier: deps.quality.graphics,
        tierSource: deps.tierSource,
        renderScale: deps.engine.renderScale,
        bufferWidth: Math.round(size.x),
        bufferHeight: Math.round(size.y),
        displayWidth: deps.canvas.clientWidth,
        displayHeight: deps.canvas.clientHeight,
        liveAA: deps.builtStages().filter((e) => AA_EFFECTS.includes(e)),
        scenePassWidth: Math.round(size.x * Math.min(1, deps.engine.renderScale)),
        scenePassHeight: Math.round(size.y * Math.min(1, deps.engine.renderScale)),
        hardwareCeiling: deps.caps.maxTextureSize / Math.max(1, deps.canvas.clientWidth),
        maxTextureSize: deps.caps.maxTextureSize,
        pipelines:
          (deps.renderer.info as unknown as { render?: { pipelines?: number } }).render
            ?.pipelines ?? 0,
        score: deps.field.scoreValue,
        multiplier: deps.field.multiplierValue,
        corridor: deps.field.corridorDims,
      };
    },

    freeze: () => {
      frozen = true;
      deps.engine.setPaused(true);
      document.documentElement.dataset['frozen'] = 'true';
    },
    unfreeze: () => {
      frozen = false;
      deps.engine.setPaused(false);
      delete document.documentElement.dataset['frozen'];
    },
    step: (dtMs: number) => {
      deps.field.testStep(dtMs);
      // A frozen engine still has to present, or a capture shows the pre-step frame.
      if (frozen) deps.engine.renderOnce();
    },

    place: (kind, distanceM, offsetX = 0) => deps.field.testPlaceOnly(kind, distanceM, offsetX),
    clearField: () => deps.field.testClearField(),
    advanceTo: (approach: number) => deps.field.testAdvanceTo(approach),
    throwAt: (x: number, y: number) => deps.field.throwAt(x, y),
    shatter: () => deps.field.testShatter(),
    restart: () => deps.field.restart(),

    ballWorld: () => deps.ballWorld(),

    project: (x: number, y: number, z: number) => {
      const v = { x, y, z };
      const p = deps.camera as unknown as {
        projectionMatrix: unknown;
        matrixWorldInverse: unknown;
      };
      void p;
      const proj = projectPoint(deps.camera, v);
      if (proj === null) return null;
      return {
        x: (proj.x * 0.5 + 0.5) * deps.canvas.clientWidth,
        y: (-proj.y * 0.5 + 0.5) * deps.canvas.clientHeight,
      };
    },
  };

  window.__sp = bridge;
  return bridge;
}

/** Minimal NDC projection, kept here so the bridge owns no three-specific scratch state. */
function projectPoint(
  camera: PerspectiveCamera,
  v: { x: number; y: number; z: number },
): { x: number; y: number; z: number } | null {
  const c = camera as unknown as {
    updateMatrixWorld: () => void;
    matrixWorldInverse: { elements: number[] };
    projectionMatrix: { elements: number[] };
  };
  c.updateMatrixWorld();
  const view = apply(c.matrixWorldInverse.elements, v, 1);
  const clip = apply(c.projectionMatrix.elements, view, 1);
  if (clip.w === 0) return null;
  return { x: clip.x / clip.w, y: clip.y / clip.w, z: clip.z / clip.w };
}

function apply(
  m: readonly number[],
  v: { x: number; y: number; z: number },
  w: number,
): { x: number; y: number; z: number; w: number } {
  const g = (i: number): number => m[i] ?? 0;
  return {
    x: g(0) * v.x + g(4) * v.y + g(8) * v.z + g(12) * w,
    y: g(1) * v.x + g(5) * v.y + g(9) * v.z + g(13) * w,
    z: g(2) * v.x + g(6) * v.y + g(10) * v.z + g(14) * w,
    w: g(3) * v.x + g(7) * v.y + g(11) * v.z + g(15) * w,
  };
}

declare global {
  interface Window {
    __sp?: DebugBridge;
  }
}
