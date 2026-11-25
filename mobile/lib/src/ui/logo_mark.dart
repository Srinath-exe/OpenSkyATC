// The OpenATC mark: one aircraft tail fin, folded once (the web's src/design/LogoMark.tsx).
import 'package:flutter/widgets.dart';

class LogoMark extends StatelessWidget {
  const LogoMark({super.key, this.size = 20});
  final double size;
  @override
  Widget build(BuildContext context) => CustomPaint(size: Size.square(size), painter: const _Fin());
}

class _Fin extends CustomPainter {
  const _Fin();
  @override
  void paint(Canvas canvas, Size size) {
    canvas.scale(size.width / 420);
    canvas.translate(-36, -44);
    final lit = Path()
      ..moveTo(36, 452)
      ..cubicTo(110, 446, 152, 408, 188, 350)
      ..lineTo(372, 56)
      ..lineTo(248, 452)
      ..close();
    final shade = Path()
      ..moveTo(372, 56)
      ..lineTo(456, 56)
      ..lineTo(352, 452)
      ..lineTo(248, 452)
      ..close();
    Paint fill(Offset a, Offset b, List<Color> c) => Paint()
      ..isAntiAlias = true
      ..shader = LinearGradient(colors: c, begin: Alignment.topRight, end: Alignment.bottomLeft).createShader(Rect.fromPoints(a, b));
    canvas.drawPath(shade, fill(const Offset(248, 56), const Offset(456, 452), const [Color(0xFFD2752F), Color(0xFFA54D17)]));
    canvas.drawPath(lit, fill(const Offset(36, 56), const Offset(372, 452), const [Color(0xFFFFB25C), Color(0xFFF5933F)]));
  }

  @override
  bool shouldRepaint(_Fin oldDelegate) => false;
}
