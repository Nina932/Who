/**
 * GLSL shared by the cockpit's shader materials.
 *
 * Hand-rolled value noise rather than a library: it is a few lines, it keeps
 * the bundle free of a noise dependency, and both the nebula and the core need
 * the *same* field so the world feels like one substance.
 */

export const NOISE = /* glsl */ `
  float hash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
  }

  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(
        mix(hash(i + vec3(0.0, 0.0, 0.0)), hash(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x),
        f.y
      ),
      mix(
        mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x),
        f.y
      ),
      f.z
    );
  }

  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p *= 2.02;
      a *= 0.5;
    }
    return v;
  }
`;

/** The sky: an inside-out sphere of slowly churning cloud. */
export const NEBULA_VERT = /* glsl */ `
  varying vec3 vPos;
  void main() {
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const NEBULA_FRAG = /* glsl */ `
  varying vec3 vPos;
  uniform float uTime;
  uniform float uEnergy;
  ${NOISE}

  void main() {
    vec3 d = normalize(vPos);

    // Two fields drifting at different rates so the sky never visibly loops.
    float n1 = fbm(d * 2.1 + vec3(0.0, uTime * 0.016, uTime * 0.011));
    float n2 = fbm(d * 4.7 - vec3(uTime * 0.009, 0.0, uTime * 0.013));

    vec3 deep   = vec3(0.008, 0.015, 0.035);
    vec3 teal   = vec3(0.030, 0.170, 0.235);
    vec3 violet = vec3(0.085, 0.045, 0.200);

    vec3 col = mix(deep, teal, smoothstep(0.34, 0.78, n1));
    col = mix(col, violet, smoothstep(0.48, 0.92, n2) * 0.55);

    // Hot filaments where the field peaks, lifted further when Morpheus speaks.
    col += pow(max(n1 - 0.62, 0.0), 2.0) * vec3(0.22, 0.62, 0.78) * (1.0 + uEnergy);

    // Sink the poles so the horizon reads as a volume rather than a box.
    col *= 0.55 + 0.45 * (1.0 - abs(d.y));

    gl_FragColor = vec4(col, 1.0);
  }
`;

/** The core: a displaced, fresnel-rimmed body that breathes with the voice. */
export const CORE_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uEnergy;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vNoise;
  ${NOISE}

  void main() {
    vec3 dir = normalize(position);
    float n = fbm(dir * 2.6 + vec3(uTime * 0.22));
    vNoise = n;

    // Displacement is what stops this reading as a sphere primitive.
    vec3 displaced = position + normal * (n - 0.5) * (1.1 + uEnergy * 1.5);

    vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

export const CORE_FRAG = /* glsl */ `
  uniform float uEnergy;
  uniform vec3 uColor;
  uniform vec3 uHot;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vNoise;

  void main() {
    float fresnel = pow(1.0 - max(dot(vNormal, vView), 0.0), 2.6);
    vec3 body = mix(uColor, uHot, smoothstep(0.35, 0.85, vNoise));
    vec3 col = body * (0.13 + uEnergy * 0.26) + fresnel * uHot * (0.85 + uEnergy * 0.65);
    gl_FragColor = vec4(col, 0.26 + fresnel * 0.5);
  }
`;

/** A thin rim shell that hangs just outside the core and catches the light. */
export const SHELL_FRAG = /* glsl */ `
  uniform float uEnergy;
  uniform vec3 uColor;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vNoise;

  void main() {
    float fresnel = pow(1.0 - max(dot(vNormal, vView), 0.0), 3.4);
    float alpha = fresnel * (0.3 + uEnergy * 0.35);
    gl_FragColor = vec4(uColor * (0.7 + uEnergy * 0.5), alpha);
  }
`;
