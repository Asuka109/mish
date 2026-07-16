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

  float waterHeight(vec2 position, float time) {
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

  void main() {
    float aspect = u_resolution.x / max(u_resolution.y, 1.0);
    vec2 surfacePoint = (v_uv - 0.5) * vec2(aspect, 1.0) * 1.40;
    surfacePoint.x -= u_time * 0.42;
    float gradientStep = 0.018;
    float height = waterHeight(surfacePoint, u_time);
    float heightX = waterHeight(surfacePoint + vec2(gradientStep, 0.0), u_time);
    float heightY = waterHeight(surfacePoint + vec2(0.0, gradientStep), u_time);
    vec2 gradient = vec2(heightX - height, heightY - height) / gradientStep;

    vec3 normal = normalize(vec3(-gradient.x * 1.15, -gradient.y * 1.15, 1.0));
    vec3 lightDirection = normalize(vec3(-0.58, 0.34, 0.74));
    vec3 halfVector = normalize(lightDirection + vec3(0.0, 0.0, 1.0));
    float refraction = clamp(0.5 + dot(normal.xy, vec2(-0.78, 0.46)) * 0.76, 0.0, 1.0);
    float crestLight = pow(max(dot(normal, halfVector), 0.0), 7.0);
    float fold = smoothstep(0.34, 0.92, length(gradient));
    float trough = clamp(0.5 - dot(normal, lightDirection) * 0.62, 0.0, 1.0);

    vec3 deepBlue = vec3(0.04, 0.16, 0.52);
    vec3 clearBlue = vec3(0.35, 0.62, 0.98);
    vec3 reflectedWhite = vec3(0.66, 0.80, 0.98);
    vec3 surfaceColor = mix(deepBlue, clearBlue, refraction);
    surfaceColor = mix(surfaceColor, reflectedWhite, crestLight * 0.50);
    surfaceColor = mix(surfaceColor, deepBlue, trough * 0.30);

    float alpha = clamp(
      0.16 + abs(refraction - 0.5) * 0.52 + crestLight * 0.22 + fold * 0.08,
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
    let animationFrame = null;

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

      if (!reducedMotion && !document.hidden) {
        animationFrame = window.requestAnimationFrame(draw);
      }
    };

    const start = () => {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame((timestamp) => {
        animationFrame = null;
        draw(timestamp);
      });
    };

    const handleVisibilityChange = () => {
      if (document.hidden && animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = null;
        return;
      }

      if (!document.hidden && !reducedMotion) start();
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
