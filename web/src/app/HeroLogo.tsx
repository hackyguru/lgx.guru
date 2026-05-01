"use client";

import { useEffect, useRef, useCallback } from "react";

/* ── SVG paths extracted from lgx-logo.svg ───────────────────────────── */

const SVG_VIEWBOX = "0 0 150 150";
const GRAY_PATH = "m85 76.9c-11.1 0.9-22.1 2.7-32.8 3.3-12 0.4-24.2 0.4-47.6-1.6v22.4l24.5-1 2.9-1 10.2-1-0.2 24.4 32.6-3.3 1.5-9.4 12-2.9 0.7-6.8 25.2-3.6 2.5-2.9 5.7 4.9 23.2-0.4v-20.3c-8.7-1-18.4-1.8-32.5-1.9-8.2 0-15.3 0.1-21.1 0.5";
const BLACK_PATH = "m141.3 37.1-18.2 0.8c-1.8 0.1-3.6 0.7-5.3 2.1-1.4-2.7-4.6-4.8-8.5-4.3l-18.7 2.4c-1.9 0.3-3.7 1.1-5 2.3-1.2-0.3-2.5-0.3-4 0.1l-5 1.1c-1.6-2.2-4.6-3.8-8.2-3.2l-21.6 3.8c-2.7 0.6-5.3 2.5-6.4 4.8l-5.5 0.6v-17.7c0-4.5-4.1-8.5-9.1-8.1l-18.3 1.6c-3.8 0.3-6.6 3.7-6.6 7.1v67.2c0 4.7 4 8.7 9.2 8.4l16.7-0.5c1.9 0 3.8-0.7 5.2-2 0.9 0.2 1.9 0.2 2.9 0.1l3.6-0.4c-0.3 0.9-0.4 1.9-0.4 2.6v14c0 4.9 4.5 8.9 10.3 8l24.5-4.4c3.9-0.6 6.4-3.7 6.3-7.5v-2.5l6.7-1.5c3.4-0.7 6.5-3.6 6.5-8.3l19.2-2.9c1.8-0.2 3.2-0.9 4.5-2.2 1.3 2.7 4 4.7 7.5 4.7l18.4-0.7c4-0.1 7.1-3.2 7.1-7.7v-23.9c0-0.9-0.2-2.1-0.7-3 0.5-0.8 0.7-1.8 0.7-2.8v-20.9c-0.2-3.9-3.7-7.3-7.8-7.2zm-115.1 59.8-17.6 0.6v-66.2l17.6-1.5v67.1zm57.6 6.5-12.7 3.2v9.3l-24.5 4.2v-14.5l19.5-3.5v-6.1l-19.5 3.2v-5.3l-12.5 1.2v-38.7l14.3-1.8v-4.7l21.3-4.2v5.7l14.1-3.7v55.7zm57.6-38.6-13.5 0.3v6.6l13.5-0.4v22.9l-17.8 0.7v-18.1l-13.6 1.3v14.6l-18.2 2.4v-19.4l13.9-2.1v-6.7l-13.9 2.2v-23.7l18.2-2.3v19.1l13.6-1.3v-15.7l17.8-0.7v20.3zm-88.8 0.3 13.5-2.5v19.6l-13.5 2.3v-19.4z";

function makeSvgDataUrl(path: string, fill: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${SVG_VIEWBOX}"><path fill="${fill}" d="${path}"/></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

/* ── shaders ─────────────────────────────────────────────────────────── */

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main(){
  v_uv = a_pos * vec2(0.5, -0.5) + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_gray;
uniform sampler2D u_black;
uniform float u_time;
uniform vec2  u_mouse;
uniform float u_hover;
uniform float u_dark;
uniform vec2  u_resolution;

// 8x8 Bayer matrix for finer ordered dithering
float bayer8(vec2 p){
  vec2 c = floor(mod(p, 8.0));
  int x = int(c.x);
  int y = int(c.y);
  int i = x + y * 8;
  // Bayer 8x8 (values 0-63, normalised)
  float b[64];
  b[0]= 0.0; b[1]=32.0; b[2]= 8.0; b[3]=40.0; b[4]= 2.0; b[5]=34.0; b[6]=10.0; b[7]=42.0;
  b[8]=48.0; b[9]=16.0;b[10]=56.0;b[11]=24.0;b[12]=50.0;b[13]=18.0;b[14]=58.0;b[15]=26.0;
  b[16]=12.0;b[17]=44.0;b[18]= 4.0;b[19]=36.0;b[20]=14.0;b[21]=46.0;b[22]= 6.0;b[23]=38.0;
  b[24]=60.0;b[25]=28.0;b[26]=52.0;b[27]=20.0;b[28]=62.0;b[29]=30.0;b[30]=54.0;b[31]=22.0;
  b[32]= 3.0;b[33]=35.0;b[34]=11.0;b[35]=43.0;b[36]= 1.0;b[37]=33.0;b[38]= 9.0;b[39]=41.0;
  b[40]=51.0;b[41]=19.0;b[42]=59.0;b[43]=27.0;b[44]=49.0;b[45]=17.0;b[46]=57.0;b[47]=25.0;
  b[48]=15.0;b[49]=47.0;b[50]= 7.0;b[51]=39.0;b[52]=13.0;b[53]=45.0;b[54]= 5.0;b[55]=37.0;
  b[56]=63.0;b[57]=31.0;b[58]=55.0;b[59]=23.0;b[60]=61.0;b[61]=29.0;b[62]=53.0;b[63]=21.0;
  // loop to index (WebGL1 doesn't support dynamic array indexing)
  float val = 0.0;
  for(int k = 0; k < 64; k++){
    if(k == i){ val = b[k]; break; }
  }
  return val / 64.0;
}

// brand gradient: amber #ff9900 core, warm tones only
vec3 gradientColor(float pos){
  vec3 deep  = vec3(0.80, 0.33, 0.05); // burnt orange
  vec3 amber = vec3(1.00, 0.60, 0.00); // #ff9900
  vec3 gold  = vec3(1.00, 0.82, 0.30); // warm gold

  // smooth two-segment gradient, no wrapping
  float s1 = smoothstep(0.0, 0.5, pos);
  float s2 = smoothstep(0.5, 1.0, pos);
  return mix(mix(deep, amber, s1), gold, s2);
}

void main(){
  vec2 uv = v_uv;

  vec4 gray = texture2D(u_gray, uv);
  vec4 black = texture2D(u_black, uv);

  // pixel coords for dither grid
  vec2 px = uv * u_resolution;
  float t = u_time;

  // mouse proximity
  vec2 d = uv - u_mouse;
  float dist = length(d);
  float mouseInfluence = exp(-dist * 3.5) * u_hover;

  // smooth animated gradient across the gray shape
  // slowly rotating sweep direction
  float angle = t * 0.2;
  vec2 dir = vec2(cos(angle), sin(angle));
  // project uv onto sweep direction, normalised to 0-1
  float gradPos = dot(uv - 0.5, dir) * 0.8 + 0.5;
  // gentle wave for organic feel (small amplitude, no hard breaks)
  gradPos += sin(uv.x * 3.0 + t * 0.6) * 0.05 + cos(uv.y * 2.5 + t * 0.5) * 0.05;
  // mouse softly shifts gradient
  gradPos += mouseInfluence * 0.15;
  // ping-pong: smoothly bounce 0→1→0 instead of wrapping
  gradPos = abs(mod(gradPos, 2.0) - 1.0);

  vec3 gradCol = gradientColor(gradPos);

  // dither at larger scale (lower multiplier = bigger dots)
  float dither = bayer8(px * 0.25);
  // high base density so the dither pattern is clearly visible
  float density = gray.a * 0.82;
  // mouse boosts density nearby
  density = min(density + mouseInfluence * 0.15, 1.0);
  float mask = step(dither, density);

  // final gray layer: gradient-coloured dither dots
  vec3 grayResult = gradCol * mask;
  float grayAlpha = gray.a * mask;

  // composite: dithered gray behind solid black
  vec3 col = grayResult;
  float a = grayAlpha;
  col = mix(col, black.rgb, black.a);
  a = max(a, black.a);

  // dark mode: invert only the black letterforms, keep gradient colours
  float isBlack = black.a;
  vec3 invertedBlack = vec3(1.0) - black.rgb;
  col = mix(col, col, 0.0); // no-op placeholder for clarity
  // invert black parts in dark mode, leave gradient as-is
  vec3 darkCol = mix(grayResult, invertedBlack, isBlack);
  float darkA = a;
  col = mix(col, darkCol, u_dark);
  a = mix(a, darkA, u_dark);

  gl_FragColor = vec4(col, a);
}`;

/* ── helpers ──────────────────────────────────────────────────────────── */

function compileShader(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return s;
}

function createProgram(gl: WebGLRenderingContext) {
  const p = gl.createProgram()!;
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(p);
  return p;
}

function rasteriseSvg(dataUrl: string, size: number): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const ctx = c.getContext("2d")!;
      const pad = size * 0.1;
      const s = size - pad * 2;
      ctx.drawImage(img, pad, pad, s, s);
      resolve(c);
    };
    img.onerror = reject;
    img.crossOrigin = "anonymous";
    img.src = dataUrl;
  });
}

function uploadTexture(gl: WebGLRenderingContext, unit: number): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,0]));
  return tex;
}

/* ── component ───────────────────────────────────────────────────────── */

export default function HeroLogo() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({
    mouse: [0.5, 0.5] as [number, number],
    hover: 0,
    targetHover: 0,
    dark: 0,
    raf: 0,
  });

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
    stateRef.current.mouse[0] = (e.clientX - r.left) / r.width;
    stateRef.current.mouse[1] = 1 - (e.clientY - r.top) / r.height;
  }, []);

  const onPointerEnter = useCallback(() => { stateRef.current.targetHover = 1; }, []);
  const onPointerLeave = useCallback(() => {
    stateRef.current.targetHover = 0;
    stateRef.current.mouse = [0.5, 0.5];
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false });
    if (!gl) return;

    const prog = createProgram(gl);
    gl.useProgram(prog);

    // full-screen quad
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // uniforms
    const uGray  = gl.getUniformLocation(prog, "u_gray");
    const uBlack = gl.getUniformLocation(prog, "u_black");
    const uTime  = gl.getUniformLocation(prog, "u_time");
    const uMouse = gl.getUniformLocation(prog, "u_mouse");
    const uHover = gl.getUniformLocation(prog, "u_hover");
    const uDark  = gl.getUniformLocation(prog, "u_dark");
    const uRes   = gl.getUniformLocation(prog, "u_resolution");

    // two textures: gray layer (unit 0), black layer (unit 1)
    const texGray = uploadTexture(gl, 0);
    const texBlack = uploadTexture(gl, 1);
    gl.uniform1i(uGray, 0);
    gl.uniform1i(uBlack, 1);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = Math.max(Math.round(Math.min(canvas.clientWidth, canvas.clientHeight) * dpr), 512);

    // rasterise each layer separately
    const grayUrl = makeSvgDataUrl(GRAY_PATH, "#B2B2B2");
    const blackUrl = makeSvgDataUrl(BLACK_PATH, "#010101");

    Promise.all([rasteriseSvg(grayUrl, size), rasteriseSvg(blackUrl, size)]).then(([gBitmap, bBitmap]) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texGray);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, gBitmap);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texBlack);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bBitmap);
    });

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const st = stateRef.current;
    const t0 = performance.now();

    const resize = () => {
      const w = canvas.clientWidth * dpr;
      const h = canvas.clientHeight * dpr;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };

    const frame = () => {
      resize();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      st.hover += (st.targetHover - st.hover) * 0.08;
      st.dark = document.documentElement.classList.contains("dark") ? 1 : 0;

      gl.uniform1f(uTime, (performance.now() - t0) / 1000);
      gl.uniform2f(uMouse, st.mouse[0], st.mouse[1]);
      gl.uniform1f(uHover, st.hover);
      gl.uniform1f(uDark, st.dark);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      st.raf = requestAnimationFrame(frame);
    };
    st.raf = requestAnimationFrame(frame);

    return () => cancelAnimationFrame(st.raf);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      onPointerMove={onPointerMove}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className="aspect-square w-full max-w-[480px] cursor-crosshair touch-none"
      style={{ imageRendering: "auto" }}
    />
  );
}
