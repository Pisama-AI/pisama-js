# @whoopsie/detectors retirement bridge

This package name is retired. Version 0.7.0 is a zero-logic compatibility
bridge that re-exports `@pisama/detectors@0.10.1` exactly.

New code should depend on and import `@pisama/detectors` directly. Existing
code can use this bridge briefly while updating package names. The bridge has
no network implementation, install lifecycle, or detector fork of its own.

Versions below 0.7.0 remain historical bytes. This opt-in breaking-line bridge
does not alter pinned or caret consumers on older major-zero ranges.
