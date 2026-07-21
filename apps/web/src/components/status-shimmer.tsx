import { useEffect, useRef } from "react";

const vertexShaderSource = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const fragmentShaderSource = `
precision highp float;

uniform vec2 u_resolution;
uniform float u_time;
varying vec2 v_uv;

vec2 waveWithDerivative(vec2 point, vec2 direction, float frequency, float phase) {
  float x = dot(direction, point) * frequency + phase;
  float wave = exp(sin(x) - 1.0);
  return vec2(wave, -wave * cos(x));
}

float waterHeight(vec2 point, float time) {
  float iterator = 0.0;
  float frequency = 1.48;
  float speed = 0.12;
  float weight = 1.0;
  float height = 0.0;
  float weightSum = 0.0;

  for (int octave = 0; octave < 7; octave++) {
    vec2 randomDirection = normalize(vec2(sin(iterator), cos(iterator)));
    vec2 direction = normalize(mix(vec2(0.38, 0.92), randomDirection, 0.52));
    vec2 wave = waveWithDerivative(point, direction, frequency, time * speed);
    point += direction * wave.y * weight * 0.38;
    height += wave.x * weight;
    weightSum += weight;
    weight *= 0.76;
    frequency *= 1.20;
    speed *= 1.07;
    iterator += 1232.399963;
  }

  return height / weightSum;
}

float diagonalHighlight(vec2 uv, float time) {
  float center = mix(-0.48, 1.48, fract(time * 0.24));
  float coordinate = uv.x - (uv.y - 0.5) * 0.52;
  float distanceToBand = abs(coordinate - center);
  return 1.0 - smoothstep(0.04, 0.38, distanceToBand);
}

void main() {
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec2 point = (v_uv - 0.5) * vec2(aspect, 1.0) * 1.40;
  point.x -= u_time * 0.63;
  float stepSize = 0.018;
  float height = waterHeight(point, u_time);
  vec2 gradient = vec2(
    waterHeight(point + vec2(stepSize, 0.0), u_time) - height,
    waterHeight(point + vec2(0.0, stepSize), u_time) - height
  ) / stepSize;

  vec3 normal = normalize(vec3(-gradient.x * 1.15, -gradient.y * 1.15, 1.0));
  vec3 light = normalize(vec3(-0.58, 0.34, 0.74));
  float refraction = clamp(0.5 + dot(normal.xy, vec2(-0.78, 0.46)) * 0.68, 0.0, 1.0);
  float crest = pow(max(dot(normal, normalize(light + vec3(0.0, 0.0, 1.0))), 0.0), 7.0);
  float highlight = diagonalHighlight(v_uv, u_time);
  float fold = smoothstep(0.34, 0.92, length(gradient));

  vec3 deepBlue = vec3(0.04, 0.16, 0.52);
  vec3 clearBlue = vec3(0.35, 0.62, 0.98);
  vec3 surfaceColor = mix(deepBlue, clearBlue, refraction);
  surfaceColor = mix(surfaceColor, vec3(0.54, 0.70, 0.95), crest * 0.30);
  surfaceColor = mix(surfaceColor, vec3(0.64, 0.85, 1.0), highlight * 0.46);

  float alpha = clamp(0.16 + abs(refraction - 0.5) * 0.42 + crest * 0.16 + highlight * 0.14 + fold * 0.08, 0.16, 0.58);
  gl_FragColor = vec4(surfaceColor * alpha, alpha);
}
`;

interface NavigatorCapabilities extends Navigator {
  connection?: { saveData?: boolean };
  deviceMemory?: number;
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

function createProgram(gl: WebGLRenderingContext) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  if (!vertexShader || !fragmentShader) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
  gl.deleteProgram(program);
  return null;
}

function getTargetFrameRate() {
  const capabilities = navigator as NavigatorCapabilities;
  const coreCount = capabilities.hardwareConcurrency;
  const deviceMemory = capabilities.deviceMemory;
  const saveData = capabilities.connection?.saveData === true;
  const slowUpdate = window.matchMedia("(update: slow)").matches;

  if (saveData || slowUpdate || coreCount <= 4 || (deviceMemory !== undefined && deviceMemory <= 4))
    return 30;
  if (coreCount >= 8 && (deviceMemory === undefined || deviceMemory >= 8)) return 60;
  return 45;
}

interface StatusShimmerProps {
  active: boolean;
}

export const STATUS_SHIMMER_UNFOCUSED_FRAME_RATE = 24;

type StatusShimmerAnimationMode = "focused" | "static" | "stopped" | "unfocused";

export interface StatusShimmerAnimationPolicy {
  frameRate: number;
  mode: StatusShimmerAnimationMode;
}

export function getStatusShimmerAnimationPolicy(
  reducedMotion: boolean,
  targetDocument: Document = document,
  focusedFrameRate = getTargetFrameRate(),
): StatusShimmerAnimationPolicy {
  if (targetDocument.hidden) return { frameRate: 0, mode: "stopped" };
  if (reducedMotion) return { frameRate: 0, mode: "static" };
  if (targetDocument.hasFocus()) {
    return { frameRate: focusedFrameRate, mode: "focused" };
  }
  return {
    frameRate: STATUS_SHIMMER_UNFOCUSED_FRAME_RATE,
    mode: "unfocused",
  };
}

export function advanceStatusShimmerAnimationTime(
  currentTimeSeconds: number | null,
  timestamp: number,
  elapsedMilliseconds: number,
) {
  if (currentTimeSeconds === null) return timestamp / 1000;
  return currentTimeSeconds + elapsedMilliseconds / 1000;
}

export function shouldAnimateStatusShimmer(
  reducedMotion: boolean,
  targetDocument: Document = document,
) {
  const { mode } = getStatusShimmerAnimationPolicy(reducedMotion, targetDocument);
  return mode === "focused" || mode === "unfocused";
}

interface StatusShimmerAnimationLoopOptions {
  cancelFrame: (handle: number) => void;
  clearTimer: (handle: number) => void;
  draw: (
    timestamp: number,
    elapsedMilliseconds: number,
    policy: StatusShimmerAnimationPolicy,
  ) => void;
  getPolicy: () => StatusShimmerAnimationPolicy;
  requestFrame: (callback: FrameRequestCallback) => number;
  setTimer: (callback: () => void, delay: number) => number;
}

export function createStatusShimmerAnimationLoop({
  cancelFrame,
  clearTimer,
  draw,
  getPolicy,
  requestFrame,
  setTimer,
}: StatusShimmerAnimationLoopOptions) {
  let animationFrame: number | null = null;
  let animationTimer: number | null = null;
  let disposed = false;
  let lastDrawTime: number | null = null;

  function cancelScheduledWork() {
    if (animationFrame !== null) cancelFrame(animationFrame);
    if (animationTimer !== null) clearTimer(animationTimer);
    animationFrame = null;
    animationTimer = null;
  }

  function requestNextFrame(delay = 0) {
    if (disposed || animationFrame !== null || animationTimer !== null) return;
    if (delay > 0) {
      animationTimer = setTimer(() => {
        animationTimer = null;
        if (!disposed) animationFrame = requestFrame(tick);
      }, delay);
      return;
    }
    animationFrame = requestFrame(tick);
  }

  function tick(timestamp: number) {
    animationFrame = null;
    const policy = getPolicy();
    if (policy.mode === "stopped") {
      lastDrawTime = null;
      return;
    }
    if (policy.mode === "static") {
      lastDrawTime = null;
      draw(timestamp, 0, policy);
      return;
    }

    const frameInterval = 1000 / policy.frameRate;
    const elapsedMilliseconds = lastDrawTime === null ? Infinity : timestamp - lastDrawTime;
    if (elapsedMilliseconds >= frameInterval) {
      draw(timestamp, lastDrawTime === null ? 0 : elapsedMilliseconds, policy);
      lastDrawTime = timestamp;
    }

    if (policy.mode === "focused") {
      requestNextFrame();
      return;
    }
    requestNextFrame(Math.max(0, frameInterval - (timestamp - (lastDrawTime ?? timestamp))));
  }

  function sync() {
    if (disposed) return;
    cancelScheduledWork();
    const { mode } = getPolicy();
    if (mode === "stopped") {
      lastDrawTime = null;
      return;
    }
    if (mode === "static") lastDrawTime = null;
    requestNextFrame();
  }

  return {
    dispose() {
      disposed = true;
      cancelScheduledWork();
      lastDrawTime = null;
    },
    sync,
  };
}

export function StatusShimmer({ active }: StatusShimmerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!active) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const canvasElement: HTMLCanvasElement = canvas;

    const gl = canvasElement.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      powerPreference: "low-power",
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      stencil: false,
    });
    if (!gl) return undefined;
    const context: WebGLRenderingContext = gl;

    const program = createProgram(context);
    const positionBuffer = context.createBuffer();
    if (!program || !positionBuffer) return undefined;

    const positionLocation = context.getAttribLocation(program, "a_position");
    const resolutionLocation = context.getUniformLocation(program, "u_resolution");
    const timeLocation = context.getUniformLocation(program, "u_time");
    context.bindBuffer(context.ARRAY_BUFFER, positionBuffer);
    context.bufferData(
      context.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      context.STATIC_DRAW,
    );
    context.useProgram(program);
    context.enableVertexAttribArray(positionLocation);
    context.vertexAttribPointer(positionLocation, 2, context.FLOAT, false, 0, 0);

    const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const focusedFrameRate = getTargetFrameRate();
    let reducedMotion = reducedMotionQuery.matches;
    let animationTimeSeconds: number | null = null;

    function resize() {
      const bounds = canvasElement.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(bounds.width * pixelRatio));
      const height = Math.max(1, Math.round(bounds.height * pixelRatio));
      if (canvasElement.width === width && canvasElement.height === height) return;
      canvasElement.width = width;
      canvasElement.height = height;
      context.viewport(0, 0, width, height);
    }

    function draw(
      timestamp: number,
      elapsedMilliseconds: number,
      policy: StatusShimmerAnimationPolicy,
    ) {
      resize();
      context.clear(context.COLOR_BUFFER_BIT);
      context.uniform2f(resolutionLocation, canvasElement.width, canvasElement.height);
      let shaderTime = 2.8;
      if (policy.mode !== "static") {
        animationTimeSeconds = advanceStatusShimmerAnimationTime(
          animationTimeSeconds,
          timestamp,
          elapsedMilliseconds,
        );
        shaderTime = animationTimeSeconds;
      }
      context.uniform1f(timeLocation, shaderTime);
      context.drawArrays(context.TRIANGLE_STRIP, 0, 4);
    }

    const animationLoop = createStatusShimmerAnimationLoop({
      cancelFrame: window.cancelAnimationFrame.bind(window),
      clearTimer: window.clearTimeout.bind(window),
      draw,
      getPolicy: () => getStatusShimmerAnimationPolicy(reducedMotion, document, focusedFrameRate),
      requestFrame: window.requestAnimationFrame.bind(window),
      setTimer: window.setTimeout.bind(window),
    });

    function handleReducedMotionChange(event: MediaQueryListEvent) {
      reducedMotion = event.matches;
      animationLoop.sync();
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvasElement);
    document.addEventListener("visibilitychange", animationLoop.sync);
    window.addEventListener("blur", animationLoop.sync);
    window.addEventListener("focus", animationLoop.sync);
    reducedMotionQuery.addEventListener("change", handleReducedMotionChange);
    animationLoop.sync();

    return () => {
      animationLoop.dispose();
      document.removeEventListener("visibilitychange", animationLoop.sync);
      window.removeEventListener("blur", animationLoop.sync);
      window.removeEventListener("focus", animationLoop.sync);
      reducedMotionQuery.removeEventListener("change", handleReducedMotionChange);
      resizeObserver.disconnect();
      context.deleteBuffer(positionBuffer);
      context.deleteProgram(program);
    };
  }, [active]);

  return <canvas aria-hidden="true" className="sidebar-status-shimmer" ref={canvasRef} />;
}
