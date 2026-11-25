import 'package:flutter/gestures.dart';
import 'package:flutter/rendering.dart';

/// A hit-test target that answers a tap: gesture detectors with a tap handler, and Material's buttons and ink wells
/// (whose handler is announced by a Semantics around them, absent when they are disabled).
bool tappable(HitTestTarget t) =>
    (t is RenderSemanticsGestureHandler && t.onTap != null) || (t is RenderSemanticsAnnotations && t.properties.onTap != null);
