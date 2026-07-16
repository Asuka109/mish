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

  vec2 waveWithDerivative(
    vec2 position,
    vec2 direction,
    float frequency,
    float phase
  ) {
    float x = dot(direction, position) * frequency + phase;
    float wave = exp(sin(x) - 1.0);
    float derivative = wave * cos(x);
    return vec2(wave, -derivative);
  }

  vec2 softWaveWithDerivative(
    vec2 position,
    vec2 direction,
    float frequency,
    float phase
  ) {
    float x = dot(direction, position) * frequency + phase;
    float wave = 0.5 + 0.5 * sin(x);
    float derivative = 0.5 * cos(x);
    return vec2(wave, -derivative);
  }

  float primaryWaterHeight(vec2 position, float time) {
    float iterator = 0.0;
    float frequency = 1.48;
    float speed = 0.12;
    float weight = 1.0;
    float height = 0.0;
    float weightSum = 0.0;

    for (int octave = 0; octave < 7; octave++) {
      vec2 randomDirection = normalize(vec2(sin(iterator), cos(iterator)));
      vec2 direction = normalize(mix(vec2(0.38, 0.92), randomDirection, 0.52));
      vec2 wave = waveWithDerivative(
        position,
        direction,
        frequency,
        time * speed
      );

      position += direction * wave.y * weight * 0.38;
      height += wave.x * weight;
      weightSum += weight;
      weight *= 0.76;
      frequency *= 1.20;
      speed *= 1.07;
      iterator += 1232.399963;
    }

    return height / weightSum;
  }

  float secondaryWaterHeight(vec2 position, float time) {
    float iterator = 713.731;
    float frequency = 2.16;
    float speed = 0.07;
    float weight = 1.0;
    float height = 0.0;
    float weightSum = 0.0;

    for (int octave = 0; octave < 5; octave++) {
      vec2 randomDirection = normalize(vec2(sin(iterator), cos(iterator)));
      vec2 direction = normalize(mix(vec2(-0.82, 0.56), randomDirection, 0.34));
      vec2 wave = softWaveWithDerivative(
        position,
        direction,
        frequency,
        time * speed
      );

      position += direction * wave.y * weight * 0.22;
      height += wave.x * weight;
      weightSum += weight;
      weight *= 0.68;
      frequency *= 1.34;
      speed *= 1.11;
      iterator += 931.197;
    }

    return height / weightSum;
  }

  float fastDiagonalHighlight(vec2 uv, float time) {
    float travel = fract(time * 0.24);
    float center = mix(-0.48, 1.48, travel);
    float diagonalCoordinate = uv.x - (uv.y - 0.5) * 0.52;
    float distanceToBand = abs(diagonalCoordinate - center);
    float halo = 1.0 - smoothstep(0.06, 0.40, distanceToBand);
    float core = 1.0 - smoothstep(0.02, 0.20, distanceToBand);
    return halo * 0.62 + core * 0.38;
  }

  void main() {
    float aspect = u_resolution.x / max(u_resolution.y, 1.0);
    vec2 centeredUv = (v_uv - 0.5) * vec2(aspect, 1.0);
    vec2 primaryPoint = centeredUv * 1.40;
    vec2 secondaryPoint = centeredUv * 2.08;
    primaryPoint.x -= u_time * 0.63;
    secondaryPoint.x -= u_time * 0.31;
    float gradientStep = 0.018;
    float primaryHeight = primaryWaterHeight(primaryPoint, u_time);
    float primaryHeightX = primaryWaterHeight(
      primaryPoint + vec2(gradientStep, 0.0),
      u_time
    );
    float primaryHeightY = primaryWaterHeight(
      primaryPoint + vec2(0.0, gradientStep),
      u_time
    );
    float secondaryHeight = secondaryWaterHeight(secondaryPoint, u_time);
    float secondaryHeightX = secondaryWaterHeight(
      secondaryPoint + vec2(gradientStep, 0.0),
      u_time
    );
    float secondaryHeightY = secondaryWaterHeight(
      secondaryPoint + vec2(0.0, gradientStep),
      u_time
    );
    vec2 primaryGradient = vec2(
      primaryHeightX - primaryHeight,
      primaryHeightY - primaryHeight
    ) / gradientStep;
    vec2 secondaryGradient = vec2(
      secondaryHeightX - secondaryHeight,
      secondaryHeightY - secondaryHeight
    ) / gradientStep;
    vec2 gradient = primaryGradient * 0.84 + secondaryGradient * 0.16;

    vec3 normal = normalize(vec3(-gradient.x * 1.15, -gradient.y * 1.15, 1.0));
    vec3 secondaryNormal = normalize(
      vec3(-secondaryGradient.x * 0.56, -secondaryGradient.y * 0.56, 1.0)
    );
    vec3 lightDirection = normalize(vec3(-0.58, 0.34, 0.74));
    vec3 halfVector = normalize(lightDirection + vec3(0.0, 0.0, 1.0));
    vec3 secondaryHalfVector = normalize(vec3(0.38, 0.46, 0.80));
    float refraction = clamp(0.5 + dot(normal.xy, vec2(-0.78, 0.46)) * 0.68, 0.0, 1.0);
    float crestLight = pow(max(dot(normal, halfVector), 0.0), 7.0);
    float secondarySheen = pow(max(dot(secondaryNormal, secondaryHalfVector), 0.0), 6.0);
    float diagonalHighlight = fastDiagonalHighlight(v_uv, u_time);
    float fold = smoothstep(0.34, 0.92, length(gradient));
    float trough = clamp(0.5 - dot(normal, lightDirection) * 0.62, 0.0, 1.0);

    vec3 deepBlue = vec3(0.04, 0.16, 0.52);
    vec3 clearBlue = vec3(0.35, 0.62, 0.98);
    vec3 reflectedWhite = vec3(0.54, 0.70, 0.95);
    vec3 surfaceColor = mix(deepBlue, clearBlue, refraction);
    surfaceColor = mix(surfaceColor, reflectedWhite, crestLight * 0.30);
    surfaceColor = mix(surfaceColor, deepBlue, trough * 0.22);
    surfaceColor = mix(surfaceColor, vec3(0.24, 0.72, 1.0), secondarySheen * 0.16);
    surfaceColor = mix(surfaceColor, vec3(0.64, 0.85, 1.0), diagonalHighlight * 0.52);

    float alpha = clamp(
      0.16
        + abs(refraction - 0.5) * 0.42
        + crestLight * 0.16
        + secondarySheen * 0.025
        + diagonalHighlight * 0.16
        + fold * 0.08,
      0.16,
      0.58
    );
    gl_FragColor = vec4(surfaceColor * alpha, alpha);
  }
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) return null;

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;

  console.warn("Status shimmer shader failed to compile", gl.getShaderInfoLog(shader));
  gl.deleteShader(shader);
  return null;
}

function createProgram(gl) {
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

  console.warn("Status shimmer program failed to link", gl.getProgramInfoLog(program));
  gl.deleteProgram(program);
  return null;
}

function getTargetFrameRate() {
  const hardwareConcurrency = navigator.hardwareConcurrency;
  const deviceMemory = navigator.deviceMemory;
  const savesData = navigator.connection?.saveData === true;
  const hasSlowUpdate = window.matchMedia("(update: slow)").matches;
  const hasKnownCoreCount = Number.isFinite(hardwareConcurrency);
  const hasKnownMemory = Number.isFinite(deviceMemory);

  if (
    savesData
    || hasSlowUpdate
    || (hasKnownCoreCount && hardwareConcurrency <= 4)
    || (hasKnownMemory && deviceMemory <= 4)
  ) {
    return 30;
  }

  if (
    hasKnownCoreCount
    && hardwareConcurrency >= 8
    && (!hasKnownMemory || deviceMemory >= 8)
  ) {
    return 60;
  }

  return 45;
}

export function StatusShimmer({ active }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!active) return undefined;

    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      powerPreference: "low-power",
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      stencil: false,
    });
    if (!gl) return undefined;

    const program = createProgram(gl);
    if (!program) return undefined;

    const positionLocation = gl.getAttribLocation(program, "a_position");
    const resolutionLocation = gl.getUniformLocation(program, "u_resolution");
    const timeLocation = gl.getUniformLocation(program, "u_time");
    const positionBuffer = gl.createBuffer();
    if (!positionBuffer) {
      gl.deleteProgram(program);
      return undefined;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.useProgram(program);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.clearColor(0, 0, 0, 0);

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const targetFrameInterval = 1000 / getTargetFrameRate();
    let animationFrame = null;
    let lastDrawTime = null;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(bounds.width * pixelRatio));
      const height = Math.max(1, Math.round(bounds.height * pixelRatio));
      if (canvas.width === width && canvas.height === height) return;

      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    };

    const draw = (timestamp) => {
      resize();
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
      gl.uniform1f(timeLocation, reducedMotion ? 2.8 : timestamp / 1000);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    const tick = (timestamp) => {
      animationFrame = null;

      if (lastDrawTime === null) {
        lastDrawTime = timestamp;
        draw(timestamp);
      } else {
        const elapsed = timestamp - lastDrawTime;
        if (elapsed >= targetFrameInterval) {
          const elapsedIntervals = Math.floor(elapsed / targetFrameInterval);
          lastDrawTime += elapsedIntervals * targetFrameInterval;
          draw(timestamp);
        }
      }

      if (!reducedMotion && !document.hidden) {
        animationFrame = window.requestAnimationFrame(tick);
      }
    };

    const start = () => {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(tick);
    };

    const handleVisibilityChange = () => {
      if (document.hidden && animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = null;
        return;
      }

      if (!document.hidden && !reducedMotion) {
        lastDrawTime = null;
        start();
      }
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    start();

    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      resizeObserver.disconnect();
      gl.deleteBuffer(positionBuffer);
      gl.deleteProgram(program);
    };
  }, [active]);

  return <canvas aria-hidden="true" className="sidebar-status-shimmer" ref={canvasRef} />;
}
