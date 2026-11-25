// Bakes the cloud sprites of the airport <-> radar passage (src/game/GameShell/CloudVeil.tsx): cumulus ray marched at high
// quality, looking down at them, sun from the upper left. Each cell: grey = how sunlit, alpha = how solid.
//   node scripts/clouds/bake.cjs            -> public/media/clouds.webp (3 x 3 cells) ; SIZE=256 for a quick look, OUT=file
const { chromium } = require('playwright'), fs = require('fs'), { execFileSync } = require('child_process')
const S = Number(process.env.SIZE || 768), OUT = process.env.OUT || 'public/media/clouds.webp'
const NOISE = `#version 300 es
precision highp float; uniform float z; out vec4 o; const float N=96.;
vec3 h3(vec3 p,float n){p=mod(p,n);p=fract(p*vec3(.1031,.1030,.0973)+.17);p+=dot(p,p.yxz+33.33);return fract((p.xxy+p.yxx)*p.zyx);}
float perlin(vec3 x,float n){x*=n;vec3 i=floor(x),f=fract(x),u=f*f*f*(f*(f*6.-15.)+10.);float r=0.;for(int k=0;k<8;k++){vec3 c=vec3(float(k&1),float((k>>1)&1),float(k>>2));vec3 w=mix(1.-u,u,c);r+=w.x*w.y*w.z*dot(h3(i+c,n)*2.-1.,f-c);}return r;}
float cells(vec3 x,float n){x*=n;vec3 i=floor(x),f=fract(x);float d=1.;for(int a=-1;a<=1;a++)for(int b=-1;b<=1;b++)for(int c=-1;c<=1;c++){vec3 g=vec3(float(a),float(b),float(c));vec3 r=g+h3(i+g,n)-f;d=min(d,dot(r,r));}return 1.-sqrt(d);}
void main(){vec3 p=vec3(gl_FragCoord.xy/N,z);
 o=vec4(clamp(cells(p,4.)*.62+cells(p,8.)*.26+cells(p,16.)*.12,0.,1.), clamp(cells(p,12.)*.62+cells(p,24.)*.38,0.,1.), clamp(.5+.9*(perlin(p,4.)*.55+perlin(p,8.)*.3+perlin(p,16.)*.15),0.,1.),1.);}`
const FRAG = `#version 300 es
precision highp float;precision highp sampler3D;uniform sampler3D nz;uniform vec2 res,off;uniform float seed,wispy;uniform vec4 sph[28];uniform int ns;out vec4 o;
float smin(float a,float b,float k){float h=max(k-abs(a-b),0.)/k;return min(a,b)-h*h*k*.25;}
float body(vec3 p){float d=9.;for(int i=0;i<ns;i++){vec3 q=p-sph[i].xyz;d=smin(d,length(q)-sph[i].w,.13);}return max(d,-(p.y+.3)*.9-.06+.0);}
float dens(vec3 p,bool hi){
 float d=body(p); if(d>.26)return 0.;
 vec3 q=p+seed*vec3(1.7,.3,2.1);
 vec3 wq=q+.06*(texture(nz,q*.9).bbb-.5);
 float big=texture(nz,wq*.62).r, mid=texture(nz,wq*1.55+.31).r;
 float e=-d*3.2+(big-.47)*1.2+(mid-.55)*.62;
 if(hi){float f=texture(nz,wq*2.3+.7).g,g=texture(nz,wq*5.1).g;e+=(f-.5)*.30*(1.-smoothstep(.2,1.2,e))+(g-.5)*.08*(1.-smoothstep(.1,.8,e));}
 float w=texture(nz,q*1.15+.2).b; if(wispy>.5){e=e*.55+(w-.52)*1.3-.1;return clamp(e*.5,0.,.34);}
 return smoothstep(.02,.42,e)*(.75+.5*w);
}
void main(){
 vec2 uv=((gl_FragCoord.xy-off)*2.-res)/res.y*.8;
 // from above, leaning: tops and a side
 vec3 rd=normalize(vec3(0.,-.80,-.60)), right=vec3(1.,0.,0.), up=normalize(cross(right,rd));
 vec3 ro=right*uv.x+up*uv.y-rd*2.;
 vec3 L=normalize(vec3(-.62,.62,-.38));
 float T=1.,c=0.,ca=0.;const int ST=170;float dt=2.9/float(ST),t=.55;
 t+=dt*fract(52.98*fract(dot(gl_FragCoord.xy,vec2(.0671,.00584))));
 for(int i=0;i<ST;i++){vec3 p=ro+rd*t;t+=dt;float d=dens(p,true);if(d<.002)continue;
  float od=0.;for(int k=0;k<9;k++){float r=.018+.017*float(k)*float(k)*.42;od+=dens(p+L*r,k<3)*(.018+.0143*float(k));}
  // light scattered many times: the same shadow again, weaker and softer
  float li=0.,a=1.,b=1.;for(int m=0;m<4;m++){li+=a*exp(-od*15.*b);a*=.52;b*=.36;}li/=1.72;
  float powd=1.-exp(-d*6.)*.3; float sky=.5+.5*smoothstep(-.35,.5,p.y);
  float e=li*powd*1.02+.2*sky; float al=1.-exp(-d*38.*dt);
  c+=T*al*e;T*=1.-al;if(T<.004)break;}
 float A=1.-T; float v=A>.002?c/A:0.;
 o=vec4(vec3(clamp(v,0.,1.)),smoothstep(.0,1.,A)*.0+A);}`
const page = ({ S, NOISE, FRAG }) => {
  const c = document.createElement('canvas'); c.width = c.height = S; const gl = c.getContext('webgl2', { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true })
  const V = '#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'
  const prog = (f) => { const p = gl.createProgram(); for (const [t, s] of [[gl.VERTEX_SHADER, V], [gl.FRAGMENT_SHADER, f]]) { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) console.log(gl.getShaderInfoLog(sh)); gl.attachShader(p, sh) } gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p); return p }
  const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  const N = 96, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_3D, t); gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA8, N, N, N); for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, k, gl.LINEAR)
  const pn = prog(NOISE), fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, N, N); gl.useProgram(pn)
  for (let i = 0; i < N; i++) { gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, t, 0, i); gl.uniform1f(gl.getUniformLocation(pn, 'z'), (i + .5) / N); gl.drawArrays(gl.TRIANGLES, 0, 3) }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  const pf = prog(FRAG); gl.useProgram(pf); const U = (n) => gl.getUniformLocation(pf, n)
  window.bake = (i) => {
    let s = 7919 * (i + 3); const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
    const sp = []; const kind = i % 9, long = kind === 2 || kind === 5 ? 1.35 : 1
    const n = 12 + Math.floor(r() * 9)
    for (let k = 0; k < n; k++) { const a = r() * 6.283, d = Math.sqrt(r()) * .55, x = Math.cos(a) * d * long, z = Math.sin(a) * d * .8; const room = Math.max(0, 1 - d / .62), rad = .12 + .22 * room * (0.6 + r() * .6); sp.push(x, -.26 + rad * .6 + room * r() * .34, z, rad) }
    while (sp.length < 112) sp.push(0, 0, 0, 0)
    gl.viewport(0, 0, S, S); gl.uniform2f(U('res'), S, S); gl.uniform2f(U('off'), 0, 0); gl.uniform1f(U('seed'), i * 3.17 + 1.3); gl.uniform1f(U('wispy'), kind >= 7 ? 1 : 0); gl.uniform4fv(U('sph'), new Float32Array(sp)); gl.uniform1i(U('ns'), n)
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.finish()
    const px = new Uint8Array(S * S * 4); gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px); let out = ''; for (let k = 0; k < px.length; k += 32768) out += String.fromCharCode.apply(null, px.subarray(k, k + 32768)); return btoa(out)
  }
}
;(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }), p = await b.newPage(); p.on('console', (m) => console.log(m.text().slice(0, 600)))
  p.setDefaultTimeout(0); await p.evaluate(page, { S, NOISE, FRAG }); const tmp = process.env.TMPDIR || '/tmp', raw = `${tmp}/clouds-cells.raw`, all = []
  for (let i = 0; i < 9; i++) { const t = Date.now(); all.push(Buffer.from(await p.evaluate((i) => window.bake(i), i), 'base64')); console.log('cell', i, Date.now() - t, 'ms') }
  fs.writeFileSync(raw, Buffer.concat(all)); await b.close()
  execFileSync('python3', ['-c', `
import numpy as np
from PIL import Image
S=${S};a=np.fromfile('${raw}',np.uint8).reshape(9,S,S,4)[:,::-1]
at=np.zeros((S*3,S*3,4),np.uint8)
yy,xx=np.mgrid[0:S,0:S];m=np.clip(np.minimum(np.minimum(xx,S-1-xx),np.minimum(yy,S-1-yy))/(S*.06),0,1)
for i in range(9):
    c=a[i].astype(float);c[...,3]*=m*m*(3-2*m)
    L=c[...,0];A=c[...,3]/255;from scipy.ndimage import gaussian_filter as G
    f=G(L*A,S/40)/np.maximum(G(A,S/40),1e-3);L=np.where(A>.02,L,f)
    at[(i//3)*S:(i//3+1)*S,(i%3)*S:(i%3+1)*S]=np.dstack([L,L,L,c[...,3]]).clip(0,255).astype(np.uint8)
Image.fromarray(at).save('${OUT}',quality=84,method=6,alpha_quality=90)
`]); console.log(OUT, (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB')
})()
