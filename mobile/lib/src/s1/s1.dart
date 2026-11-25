// The command model on the phone: the same 2 M-parameter transformer and the same weights as the web game
// (src/lib/voice/s1.ts, whose comments explain the decoding). Pure Dart, SIMD matrix products, no runtime. Kept
// token-for-token equal to the TypeScript engine by test/s1_test.dart.

import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

final _pretok = RegExp(r'\n| ?[A-Za-z]+| ?\d| ?[^\sA-Za-z\d]+|\s+(?!\S)|\s+');
final _specialSplit = RegExp(r'<pad>|<bos>|<eos>|<ctx>|<said>|<cmd>');

class S1Tokenizer {
  S1Tokenizer(List<String> specials, List<List<int>> merges) : _base = 256 + specials.length {
    for (var i = 0; i < 256; i++) {
      _vocab.add([i]);
    }
    for (var i = 0; i < specials.length; i++) {
      special[specials[i]] = 256 + i;
      _vocab.add(utf8.encode(specials[i]));
    }
    for (var i = 0; i < merges.length; i++) {
      final a = merges[i][0], b = merges[i][1];
      _rank[a * 65536 + b] = i;
      _vocab.add([..._vocab[a], ..._vocab[b]]);
    }
  }
  final Map<String, int> special = {};
  final Map<int, int> _rank = {};
  final List<List<int>> _vocab = [];
  final Map<String, List<int>> _cache = {};
  final int _base;

  List<int> _chunk(String c) => _cache[c] ??= () {
        var ids = utf8.encode(c).toList();
        while (ids.length > 1) {
          var best = -1, bestRank = 1 << 30;
          for (var i = 0; i < ids.length - 1; i++) {
            final r = _rank[ids[i] * 65536 + ids[i + 1]];
            if (r != null && r < bestRank) {
              bestRank = r;
              best = i;
            }
          }
          if (best < 0) break;
          ids = [...ids.sublist(0, best), _base + bestRank, ...ids.sublist(best + 2)];
        }
        return ids;
      }();

  List<int> encode(String text) {
    final out = <int>[];
    void plain(String s) {
      for (final m in _pretok.allMatches(s)) {
        out.addAll(_chunk(m[0]!));
      }
    }

    var at = 0;
    for (final m in _specialSplit.allMatches(text)) {
      plain(text.substring(at, m.start));
      final id = special[m[0]!];
      id != null ? out.add(id) : plain(m[0]!);
      at = m.end;
    }
    plain(text.substring(at));
    return out;
  }

  String decode(List<int> ids) => utf8.decode([for (final i in ids) ..._vocab[i]], allowMalformed: true);
}

/// Same as s1.ts sttNormalise().
String sttNormalise(String s) => s
    .toLowerCase()
    .replaceAll('’', "'")
    .replaceAllMapped(RegExp(r'(\w)-(\w)'), (m) => '${m[1]} ${m[2]}')
    .replaceAll(RegExp(r'[^\w\s.]'), ' ')
    .replaceAll(RegExp(r'\.(?!\d)'), ' ')
    .replaceAll(RegExp(r'\s+'), ' ')
    .trim();

double _f16(int h) {
  final s = h & 0x8000 != 0 ? -1.0 : 1.0, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e == 0) return s * math.pow(2, -14) * (f / 1024);
  if (e == 31) return f != 0 ? double.nan : s * double.infinity;
  return s * math.pow(2, e - 15) * (1 + f / 1024);
}

/// Per-token evidence for the verifier (s1.ts Signals).
class S1Signals {
  double csMargin = double.infinity, pSay = 0, csMinFull = 1, insMinP = 1, insLp = 0, insMinMargin = double.infinity, digMinP = 1, digMargin = double.infinity, rwyMinP = 1, eosP = 0, csLh = double.nan, csLhMargin = double.nan;
  int nTok = 0, nSearch = 0;
  Map<String, Object?> toJson() {
    Object? n(double v) => v.isFinite ? v : null;
    return {'csMargin': n(csMargin), 'pSay': n(pSay), 'csMinFull': n(csMinFull), 'insMinP': n(insMinP), 'insLp': n(insLp), 'insMinMargin': n(insMinMargin), 'digMinP': n(digMinP), 'digMargin': n(digMargin), 'rwyMinP': n(rwyMinP), 'eosP': n(eosP), 'nTok': nTok, 'csLh': n(csLh), 'csLhMargin': n(csLhMargin), 'nSearch': nSearch};
  }
}

class S1Completion {
  S1Completion(this.line, this.tokens, this.confidence, this.ms, this.sayAgain, this.signals);
  final String line;
  final List<int> tokens;
  final double confidence, ms;
  final bool sayAgain;
  final S1Signals signals;
  Map<String, Object?> toJson() => {'line': line, 'confidence': confidence, 'ms': ms, 'sayAgain': sayAgain, 'signals': signals.toJson()};
}

class _Layer {
  _Layer(this.n1, this.qkv, this.out, this.n2, this.gate, this.up, this.down, int n)
      : k = Float32List(n),
        v = Float32List(n);
  final Float32List n1, qkv, out, n2, gate, up, down, k, v;
}

class _Result {
  _Result(this.out, this.conf, this.sg);
  final List<int> out;
  final double conf;
  final S1Signals sg;
}

const _ctxReserve = 112, _answerReserve = 52;

class S1Model {
  S1Model._(this.tok, this.d, this.heads, this.vocab, this.maxLen, this.temp, this.hid);

  /// [meta] is model.json, [bin] is model.bin.
  factory S1Model(String meta, Uint8List bin) {
    final j = jsonDecode(meta) as Map<String, dynamic>, c = j['config'] as Map<String, dynamic>;
    if (j['format'] != 'atc-s1-web-1') throw FormatException('unknown command model format ${j['format']}');
    final d = c['d'] as int;
    final m = S1Model._(
      S1Tokenizer((j['specials'] as List).cast<String>(), [for (final p in j['merges'] as List) (p as List).cast<int>()]),
      d, c['heads'] as int, c['vocab'] as int, c['max_len'] as int, ((j['temperature'] as num?) ?? 1).toDouble() == 0 ? 1 : ((j['temperature'] as num?) ?? 1).toDouble(),
      (((c['ffn_mult'] as num) * d).floor() / 64).ceil() * 64,
    );
    final bytes = ByteData.sublistView(bin), w = <String, Float32List>{};
    for (final t in (j['tensors'] as List).cast<Map<String, dynamic>>()) {
      final shape = (t['shape'] as List).cast<int>(), n = shape.fold(1, (a, b) => a * b), off = t['offset'] as int;
      final out = Float32List(n);
      if (t['dtype'] == 'f16') {
        for (var i = 0; i < n; i++) {
          out[i] = _f16(bytes.getUint16(off + 2 * i, Endian.little));
        }
      } else {
        final rows = shape[0], cols = n ~/ rows, so = t['scale_offset'] as int;
        for (var r = 0; r < rows; r++) {
          final s = bytes.getFloat32(so + 4 * r, Endian.little);
          for (var k = 0; k < cols; k++) {
            out[r * cols + k] = bytes.getInt8(off + r * cols + k) * s;
          }
        }
      }
      w[t['name'] as String] = out;
    }
    Float32List get(String k) => w[k] ?? (throw FormatException('missing tensor $k'));
    m._emb = get('emb.weight');
    m._normW = get('norm.w');
    for (var i = 0; i < (c['layers'] as int); i++) {
      final b = 'blocks.$i.';
      m._layers.add(_Layer(get('${b}n1.w'), get('${b}att.qkv.weight'), get('${b}att.out.weight'), get('${b}n2.w'), get('${b}ffn.gate.weight'), get('${b}ffn.up.weight'), get('${b}ffn.down.weight'), m.maxLen * d));
    }
    m._init();
    return m;
  }

  final S1Tokenizer tok;
  final int d, heads, vocab, maxLen, hid;
  final double temp;
  late final Float32List _emb, _normW;
  final List<_Layer> _layers = [];
  late final int _dh = d ~/ heads;
  late final Float32List _cos, _sin, _x, _h, _qkv, _att, _o, _g, _u, _sc, _logits;
  int _pos = 0, _prefixLen = 0;
  List<int> _prefix = [];
  bool _cut = false;
  final List<Float32List> _nodeKV = [], _nodeLg = [];

  void _init() {
    final half = _dh ~/ 2;
    _cos = Float32List(maxLen * half);
    _sin = Float32List(maxLen * half);
    for (var p = 0; p < maxLen; p++) {
      for (var j = 0; j < half; j++) {
        final a = p / math.pow(10000, (2 * j) / _dh);
        _cos[p * half + j] = math.cos(a);
        _sin[p * half + j] = math.sin(a);
      }
    }
    _x = Float32List(d);
    _h = Float32List(d);
    _qkv = Float32List(3 * d);
    _att = Float32List(d);
    _o = Float32List(d);
    _g = Float32List(hid);
    _u = Float32List(hid);
    _sc = Float32List(maxLen);
    _logits = Float32List(vocab);
  }

  static void _matvec(Float32List w, Float32List x, Float32List out, int rows, int cols) {
    if (cols % 4 != 0) {
      for (var r = 0; r < rows; r++) {
        var s = 0.0;
        for (var j = 0; j < cols; j++) {
          s += w[r * cols + j] * x[j];
        }
        out[r] = s;
      }
      return;
    }
    final q = cols ~/ 4, W = w.buffer.asFloat32x4List(w.offsetInBytes, rows * q), X = x.buffer.asFloat32x4List(x.offsetInBytes, q);
    for (var r = 0; r < rows; r++) {
      var s = Float32x4.zero();
      final o = r * q;
      for (var j = 0; j < q; j++) {
        s += W[o + j] * X[j];
      }
      out[r] = s.x + s.y + s.z + s.w;
    }
  }

  static void _rms(Float32List x, Float32List w, Float32List out) {
    var s = 0.0;
    for (var i = 0; i < x.length; i++) {
      s += x[i] * x[i];
    }
    final k = 1 / math.sqrt(s / x.length + 1e-6);
    for (var i = 0; i < x.length; i++) {
      out[i] = x[i] * k * w[i];
    }
  }

  void _rope(Float32List v, int base, int p) {
    final half = _dh ~/ 2, o = p * half;
    for (var hh = 0; hh < heads; hh++) {
      final b = base + hh * _dh;
      for (var j = 0; j < half; j++) {
        final x1 = v[b + 2 * j], x2 = v[b + 2 * j + 1], c = _cos[o + j], s = _sin[o + j];
        v[b + 2 * j] = x1 * c - x2 * s;
        v[b + 2 * j + 1] = x1 * s + x2 * c;
      }
    }
  }

  void _step(int token, bool want) {
    final p = _pos;
    if (p >= maxLen) throw StateError('sequence too long');
    _x.setRange(0, d, _emb, token * d);
    final scale = 1 / math.sqrt(_dh);
    for (final l in _layers) {
      _rms(_x, l.n1, _h);
      _matvec(l.qkv, _h, _qkv, 3 * d, d);
      _rope(_qkv, 0, p);
      _rope(_qkv, d, p);
      l.k.setRange(p * d, p * d + d, _qkv, d);
      l.v.setRange(p * d, p * d + d, _qkv, 2 * d);
      for (var hh = 0; hh < heads; hh++) {
        final qo = hh * _dh;
        var mx = double.negativeInfinity;
        for (var t = 0; t <= p; t++) {
          var s = 0.0;
          final ko = t * d + qo;
          for (var j = 0; j < _dh; j++) {
            s += _qkv[qo + j] * l.k[ko + j];
          }
          s *= scale;
          _sc[t] = s;
          if (s > mx) mx = s;
        }
        var sum = 0.0;
        for (var t = 0; t <= p; t++) {
          _sc[t] = math.exp(_sc[t] - mx);
          sum += _sc[t];
        }
        for (var j = 0; j < _dh; j++) {
          _att[qo + j] = 0;
        }
        for (var t = 0; t <= p; t++) {
          final w = _sc[t] / sum, vo = t * d + qo;
          for (var j = 0; j < _dh; j++) {
            _att[qo + j] += w * l.v[vo + j];
          }
        }
      }
      _matvec(l.out, _att, _o, d, d);
      for (var i = 0; i < d; i++) {
        _x[i] += _o[i];
      }
      _rms(_x, l.n2, _h);
      _matvec(l.gate, _h, _g, hid, d);
      _matvec(l.up, _h, _u, hid, d);
      for (var i = 0; i < hid; i++) {
        final g = _g[i];
        _g[i] = (g / (1 + math.exp(-g))) * _u[i];
      }
      _matvec(l.down, _g, _o, d, hid);
      for (var i = 0; i < d; i++) {
        _x[i] += _o[i];
      }
    }
    _pos = p + 1;
    if (want) {
      _rms(_x, _normW, _h);
      _matvec(_emb, _h, _logits, vocab, d);
    }
  }

  /// The game state, read while the player is still talking.
  void prefill(String ctx) {
    var ids = tok.encode('<ctx>$ctx');
    if (ids.length > maxLen - _ctxReserve) {
      var lines = ctx.split('\n');
      while (lines.length > 1 && ids.length > maxLen - _ctxReserve) {
        lines = lines.sublist(0, lines.length - 1);
        ids = tok.encode('<ctx>${lines.join('\n')}');
      }
    }
    var k = 0;
    while (k < ids.length && k < _prefixLen && ids[k] == _prefix[k]) {
      k++;
    }
    _prefix = ids.sublist(0, k);
    _prefixLen = k;
    _pos = k;
    for (var i = k; i < ids.length; i++) {
      _step(ids[i], false);
    }
    _prefix = ids;
    _prefixLen = ids.length;
  }

  S1Completion complete(String said, List<String> callsigns, {int maxNew = 48}) {
    final sw = Stopwatch()..start();
    _pos = _prefixLen;
    _cut = false;
    var words = sttNormalise(said).split(' ');
    var ids = tok.encode('<said> ${words.join(' ')}<cmd>');
    while (words.length > 1 && _prefixLen + ids.length > maxLen - _answerReserve) {
      words = words.sublist(0, words.length - 1);
      ids = tok.encode('<said> ${words.join(' ')}<cmd>');
    }
    for (var i = 0; i < ids.length; i++) {
      _step(ids[i], i == ids.length - 1);
    }
    final seqs = [for (final c in callsigns) tok.encode(' $c'), tok.encode(' SAY AGAIN')];
    final longest = seqs.fold(0, (a, s) => math.max(a, s.length)), P = _pos;
    var r = P + longest < maxLen ? _scored(seqs, maxNew) : null;
    if (r == null) {
      if (_pos != P) {
        _pos = P;
        _logits.setAll(0, _nodeLg[0]);
      }
      r = _trie(seqs, maxNew);
    }
    final line = tok.decode(r.out).trim();
    return S1Completion(line, r.out, r.conf, sw.elapsedMicroseconds / 1000, _cut || line.toUpperCase() == 'SAY AGAIN', r.sg);
  }

  double _lse(Float32List l) {
    var mx = double.negativeInfinity;
    for (var i = 0; i < vocab; i++) {
      if (l[i] > mx) mx = l[i];
    }
    var z = 0.0;
    for (var i = 0; i < vocab; i++) {
      z += math.exp(l[i] - mx);
    }
    return mx + math.log(z);
  }

  late final Uint8List _kinds = () {
    final k = Uint8List(vocab), digits = RegExp(r'^\d+$');
    for (var i = 0; i < vocab; i++) {
      final s = tok.decode([i]);
      k[i] = digits.hasMatch(s.trim()) ? 1 : (s == 'L' || s == 'R' || s == 'C') ? 2 : 0;
    }
    return k;
  }();
  late final List<int> _bound = () {
    final eos = tok.special['<eos>'];
    return [for (var i = 0; i < vocab; i++) if (i == eos || tok.decode([i]).startsWith(RegExp(r'[ \n]'))) i];
  }();

  void _ins(S1Signals sg, int next, double lp, double margin) {
    final p = math.exp(lp), kind = _kinds[next];
    sg.insMinP = math.min(sg.insMinP, p);
    sg.insLp += lp;
    sg.insMinMargin = math.min(sg.insMinMargin, margin);
    sg.eosP = p;
    if (kind == 1) {
      sg.digMinP = math.min(sg.digMinP, p);
      sg.digMargin = math.min(sg.digMargin, margin);
    } else if (kind == 2) {
      sg.rwyMinP = math.min(sg.rwyMinP, p);
    }
  }

  void _finish(S1Signals sg, int n, int nIns) {
    if (sg.csMargin == double.infinity) sg.csMargin = 20;
    if (sg.insMinMargin == double.infinity) sg.insMinMargin = 20;
    if (sg.digMargin == double.infinity) sg.digMargin = 20;
    if (nIns == 0) sg.eosP = 0;
    sg.nTok = n;
  }

  _Result _trie(List<List<int>> seqs, int maxNew) {
    final eos = tok.special['<eos>']!, out = <int>[], sg = S1Signals(), say0 = seqs.last[0];
    var constrained = true, conf = 1.0, nIns = 0;
    for (var n = 0; n < maxNew; n++) {
      final l = _logits;
      var next = -1;
      if (constrained) {
        final allowed = <int>{};
        var done = false;
        for (final s in seqs) {
          var ok = s.length >= out.length;
          for (var i = 0; ok && i < out.length; i++) {
            ok = s[i] == out[i];
          }
          if (ok) s.length == out.length ? done = true : allowed.add(s[out.length]);
        }
        if (done || allowed.isEmpty) {
          constrained = false;
        } else {
          var mx = double.negativeInfinity;
          for (final a in allowed) {
            if (l[a] > mx) {
              mx = l[a];
              next = a;
            }
          }
          var z = 0.0;
          for (final a in allowed) {
            z += math.exp((l[a] - mx) / temp);
          }
          conf *= 1 / z;
          if (n == 0 && allowed.contains(say0)) sg.pSay = math.exp((l[say0] - mx) / temp) / z;
          var second = double.negativeInfinity;
          for (final a in allowed) {
            if (a != next && l[a] > second) second = l[a];
          }
          if (second > double.negativeInfinity) sg.csMargin = math.min(sg.csMargin, (mx - second) / temp);
          sg.csMinFull = math.min(sg.csMinFull, math.exp(l[next] - _lse(l)));
        }
      }
      if (next < 0) {
        var mx = double.negativeInfinity, second = double.negativeInfinity;
        for (var i = 0; i < vocab; i++) {
          final v = l[i];
          if (v > mx) {
            second = mx;
            mx = v;
            next = i;
          } else if (v > second) {
            second = v;
          }
        }
        _ins(sg, next, mx - _lse(l), mx - second);
        nIns++;
      }
      if (next == eos) break;
      out.add(next);
      if (_pos >= maxLen) {
        _cut = true;
        break;
      }
      _step(next, true);
    }
    _finish(sg, out.length, nIns);
    return _Result(out, conf, sg);
  }

  Float32List _slotLg(int s) {
    while (_nodeLg.length <= s) {
      _nodeLg.add(Float32List(vocab));
    }
    return _nodeLg[s];
  }

  Float32List _slotKV(int s) {
    while (_nodeKV.length <= s) {
      _nodeKV.add(Float32List(2 * _layers.length * d));
    }
    return _nodeKV[s];
  }

  static const _marginCap = 2.0, _marginSteps = 4, _searchMax = 48;

  /// Callsign by full likelihood (best-first over the callsign trie, length-normalised), then the rest greedily.
  _Result? _scored(List<List<int>> seqs, int maxNew) {
    final P = _pos, nl = _layers.length, eos = tok.special['<eos>']!;
    final tk = [-1], par = [-1], dep = [-1], kids = <List<int>>[[]], full = [-1], lmax = [0];
    for (var si = 0; si < seqs.length; si++) {
      final s = seqs[si];
      var cur = 0;
      lmax[0] = math.max(lmax[0], s.length);
      for (final t in s) {
        var nx = -1;
        for (final c in kids[cur]) {
          if (tk[c] == t) {
            nx = c;
            break;
          }
        }
        if (nx < 0) {
          nx = tk.length;
          tk.add(t);
          par.add(cur);
          dep.add(dep[cur] + 1);
          kids.add([]);
          full.add(-1);
          lmax.add(0);
          kids[cur].add(nx);
        }
        cur = nx;
        lmax[cur] = math.max(lmax[cur], s.length);
      }
      if (full[cur] < 0) full[cur] = si;
    }
    double pri(double lp, int n) => lp / (lmax[n] + 1);
    final slot = Int32List(tk.length)..fillRange(0, tk.length, -1);
    final lg0 = _slotLg(0)..setAll(0, _logits);
    var used = 1;
    Float32List lgOf(int n) => n == 0 ? lg0 : _nodeLg[slot[n]];
    void load(int n) {
      for (; n > 0; n = par[n]) {
        final kv = _nodeKV[slot[n]], o = (P + dep[n]) * d;
        for (var l = 0; l < nl; l++) {
          _layers[l].k.setRange(o, o + d, kv, 2 * l * d);
          _layers[l].v.setRange(o, o + d, kv, (2 * l + 1) * d);
        }
      }
    }

    final qp = <double>[], qs = <double>[], qk = <int>[], qn = <int>[];
    void push(double p, double sc, int kind, int n) {
      qp.add(p);
      qs.add(sc);
      qk.add(kind);
      qn.add(n);
    }

    final lse0 = _lse(lg0);
    for (final c in kids[0]) {
      final sc = lg0[tk[c]] - lse0;
      push(pri(sc, c), sc, 0, c);
    }
    var best = double.nan, bestLp = double.nan, bestN = -1, margin = _marginCap, steps = 0, extra = 0;
    while (qp.isNotEmpty) {
      var j = 0;
      for (var i = 1; i < qp.length; i++) {
        if (qp[i] > qp[j]) j = i;
      }
      final pr = qp.removeAt(j), sc = qs.removeAt(j), kind = qk.removeAt(j), n = qn.removeAt(j);
      if (kind == 1) {
        if (bestN < 0) {
          best = pr;
          bestLp = sc;
          bestN = n;
          continue;
        }
        margin = math.min(best - pr, _marginCap);
        break;
      }
      if (bestN >= 0 && pr < best - _marginCap) break;
      if (bestN >= 0 && extra++ >= _marginSteps) {
        margin = math.min(best - pr, _marginCap);
        break;
      }
      if (bestN < 0 && steps >= _searchMax) return null;
      load(par[n]);
      _pos = P + dep[n];
      _step(tk[n], true);
      steps++;
      final s = used++;
      slot[n] = s;
      final kv = _slotKV(s), L = _slotLg(s)..setAll(0, _logits), o = (P + dep[n]) * d;
      for (var l = 0; l < nl; l++) {
        kv.setRange(2 * l * d, (2 * l + 1) * d, _layers[l].k, o);
        kv.setRange((2 * l + 1) * d, (2 * l + 2) * d, _layers[l].v, o);
      }
      final lse = _lse(L);
      if (full[n] >= 0) {
        var mb = double.negativeInfinity;
        for (final b in _bound) {
          if (L[b] > mb) mb = L[b];
        }
        var zb = 0.0;
        for (final b in _bound) {
          zb += math.exp(L[b] - mb);
        }
        final done = sc + mb + math.log(zb) - lse;
        push(done / (dep[n] + 2), done, 1, n);
      }
      for (final c in kids[n]) {
        final s2 = sc + L[tk[c]] - lse;
        push(pri(s2, c), s2, 0, c);
      }
    }
    final path = <int>[];
    for (var n = bestN; n > 0; n = par[n]) {
      path.insert(0, n);
    }
    load(bestN);
    _pos = P + path.length;
    _logits.setAll(0, lgOf(bestN));
    final sg = S1Signals()
      ..csLh = bestLp
      ..csLhMargin = margin
      ..nSearch = steps;
    final say0 = seqs.last[0];
    var conf = 1.0;
    for (final n in path) {
      final L = lgOf(par[n]), c = tk[n], al = kids[par[n]];
      var mx = double.negativeInfinity;
      for (final a in al) {
        if (L[tk[a]] > mx) mx = L[tk[a]];
      }
      var z = 0.0;
      for (final a in al) {
        z += math.exp((L[tk[a]] - mx) / temp);
      }
      conf *= math.exp((L[c] - mx) / temp) / z;
      if (par[n] == 0 && al.any((a) => tk[a] == say0)) sg.pSay = math.exp((L[say0] - mx) / temp) / z;
      var second = double.negativeInfinity;
      for (final a in al) {
        if (tk[a] != c && L[tk[a]] > second) second = L[tk[a]];
      }
      if (second > double.negativeInfinity) sg.csMargin = math.min(sg.csMargin, (L[c] - second) / temp);
      sg.csMinFull = math.min(sg.csMinFull, math.exp(L[c] - _lse(L)));
    }
    final out = [for (final n in path) tk[n]];
    var nIns = 0;
    for (var n = out.length; n < maxNew; n++) {
      final L = _logits;
      var mx = double.negativeInfinity, second = double.negativeInfinity, top = -1;
      for (var i = 0; i < vocab; i++) {
        final v = L[i];
        if (v > mx) {
          second = mx;
          mx = v;
          top = i;
        } else if (v > second) {
          second = v;
        }
      }
      var next = top;
      if (n == path.length) {
        var mb = double.negativeInfinity;
        for (final b in _bound) {
          if (L[b] > mb) {
            mb = L[b];
            next = b;
          }
        }
      }
      _ins(sg, next, L[next] - _lse(L), next == top ? mx - second : L[next] - mx);
      nIns++;
      if (next == eos) break;
      out.add(next);
      if (_pos >= maxLen) {
        _cut = true;
        break;
      }
      _step(next, true);
    }
    _finish(sg, out.length, nIns);
    return _Result(out, conf, sg);
  }
}
