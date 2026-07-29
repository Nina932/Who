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

/**
 * The uniforms every core material shares.
 *
 * `uEnergy` is the *state* — idle, listening, speaking — eased over about a
 * second. The four voice uniforms are the *sound*, updated every frame from
 * the microphone. Keeping them separate is what lets the orb hold a calm
 * listening posture and still react instantly to a word.
 *
 * Declared once and interpolated into each shader so the JavaScript uniform
 * objects and the GLSL cannot drift apart.
 */
export const VOICE_UNIFORMS = /* glsl */ `
  uniform float uTime;
  uniform float uEnergy;
  uniform float uVoiceVolume;
  uniform float uBass;
  uniform float uMids;
  uniform float uTreble;
`;

/** The core: a displaced, fresnel-rimmed body that breathes with the voice. */
export const CORE_VERT = /* glsl */ `
  ${VOICE_UNIFORMS}
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vNoise;
  varying float vVoice;
  ${NOISE}

  void main() {
    vec3 dir = normalize(position);
    float n = fbm(dir * 2.6 + vec3(uTime * 0.22));
    vNoise = n;
    vVoice = uVoiceVolume;

    // Three layers, because one amplitude driving one field reads as a sphere
    // being inflated rather than as a surface responding to a voice.
    //
    // Loudness roughens the whole surface; bass is a slow whole-body pulse;
    // treble is fine chatter that only shows on sibilance.
    float voiceNoise = noise(position * 2.0 + vec3(uTime * 0.5)) * (0.08 + uVoiceVolume * 0.32);
    float bassPulse = sin(uTime * 4.0) * uBass * 0.12;
    float trebleRipple = sin(dot(dir, vec3(11.0, 7.0, 13.0)) + uTime * 9.0) * uTreble * 0.05;

    float breath = (n - 0.5) * (1.1 + uEnergy * 1.5);
    vec3 displaced = position + normal * (breath + voiceNoise + bassPulse + trebleRipple);

    vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

export const CORE_FRAG = /* glsl */ `
  ${VOICE_UNIFORMS}
  uniform vec3 uColor;
  uniform vec3 uHot;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vNoise;
  varying float vVoice;

  void main() {
    float fresnel = pow(1.0 - max(dot(vNormal, vView), 0.0), 2.6);

    // Mids carry most of speech, so they are what pushes the body toward the
    // hot colour: the orb brightens on vowels rather than on any loud noise.
    float heat = smoothstep(0.35, 0.85, vNoise) + uMids * 0.45;
    vec3 body = mix(uColor, uHot, clamp(heat, 0.0, 1.0));

    // The body carries the colour and the rim carries the light. Weighting
    // the rim too heavily is what turned the orb into a grey ball: fresnel
    // uses the *hot* colour, so at high gain every surface washes to white.
    float lift = 0.42 + uEnergy * 0.55 + vVoice * 0.45;
    vec3 col = body * lift + fresnel * uHot * (0.5 + uEnergy * 0.45 + uTreble * 0.4);

    // Filaments where the noise field peaks — the internal structure that
    // makes this read as something with contents rather than a shell.
    col += pow(max(vNoise - 0.66, 0.0), 1.6) * uHot * (2.2 + uEnergy * 2.0);

    gl_FragColor = vec4(col, 0.38 + fresnel * 0.5 + vVoice * 0.12);
  }
`;

/**
 * The floor: a wave field the orb stands on.
 *
 * The single biggest reason the cockpit read as "an object on a background"
 * rather than as a place. A ground plane gives the orb somewhere to be, and
 * because the waves are driven by the same four voice uniforms, the whole
 * room reacts rather than just the thing in the middle of it.
 *
 * Drawn as lines rather than as a surface: a lit surface needs shadows and a
 * light budget to read as anything, whereas additive lines read as a field of
 * data at no cost and match everything else on screen.
 */
export const FLOOR_VERT = /* glsl */ `
  ${VOICE_UNIFORMS}
  varying vec2 vUv;
  varying float vHeight;
  varying float vDist;
  ${NOISE}

  void main() {
    vUv = uv;

    // Distance from the orb, used to sink the field away into the dark and to
    // let the waves break hardest directly underneath it.
    float d = length(position.xy);
    vDist = d;

    // Three travelling waves at different wavelengths, so the field never
    // visibly repeats, plus a slow noise swell underneath them.
    float w =
      sin(position.x * 0.14 - uTime * 0.6) * 0.8 +
      sin(position.y * 0.19 + uTime * 0.4) * 0.55 +
      sin((position.x + position.y) * 0.08 + uTime * 0.25) * 0.9;

    w += (noise(vec3(position.xy * 0.07, uTime * 0.08)) - 0.5) * 1.6;

    // Voice lifts the whole field, and bass makes it swell from the centre
    // outward — the orb pushing the ground away when it speaks.
    float voice = 1.0 + uVoiceVolume * 2.2;
    float swell = uBass * 3.2 * exp(-d * 0.055) * sin(d * 0.22 - uTime * 2.2);
    float ripple = uTreble * 0.8 * sin(d * 0.9 - uTime * 6.0);

    float height = w * voice + swell + ripple;
    vHeight = height;

    vec3 displaced = position + vec3(0.0, 0.0, height);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

export const FLOOR_FRAG = /* glsl */ `
  ${VOICE_UNIFORMS}
  uniform vec3 uColor;
  uniform vec3 uHot;
  varying vec2 vUv;
  varying float vHeight;
  varying float vDist;

  void main() {
    // Contour lines across the field. The line is widened with distance by
    // hand rather than with fwidth(), which needs an extension on WebGL1 and
    // would silently give a black floor on the machines that lack it.
    float lines = vUv.y * 130.0;
    float edge = abs(fract(lines) - 0.5);
    float width = 0.055 + vDist * 0.0022;
    float line = 1.0 - smoothstep(0.0, width, edge);

    // Crests catch the hot colour; troughs stay in the base.
    float crest = smoothstep(0.0, 4.0, vHeight);
    vec3 col = mix(uColor, uHot, crest * (0.4 + uVoiceVolume * 0.6));

    // Two fades, and the near one matters most. Without it the field runs up
    // under the camera and fills the frame, which is what turned the cockpit
    // into a landscape with an orb parked in it.
    float fade = 1.0 - smoothstep(26.0, 62.0, vDist);
    float near = smoothstep(3.0, 14.0, vDist);

    float alpha = line * fade * near * (0.26 + uVoiceVolume * 0.45 + uMids * 0.25);
    if (alpha < 0.002) discard;
    gl_FragColor = vec4(col * (0.8 + crest * 0.9), alpha);
  }
`;

/** A thin rim shell that hangs just outside the core and catches the light. */
export const SHELL_FRAG = /* glsl */ `
  ${VOICE_UNIFORMS}
  uniform vec3 uColor;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vNoise;
  varying float vVoice;

  void main() {
    // A tight rim. At 3.4 the falloff was wide enough to read as fog sitting
    // over the core rather than as an edge around it.
    float fresnel = pow(1.0 - max(dot(vNormal, vView), 0.0), 5.5);
    float alpha = fresnel * (0.5 + uEnergy * 0.5 + vVoice * 0.5);
    gl_FragColor = vec4(uColor * (1.1 + uEnergy * 0.6 + uBass * 0.6), alpha);
  }
`;
