A slow Java is not a missing Java

## Java

- **A `java -version` that takes too long to answer is asked again** before it counts against
  the binary. mcctl starts every Java on the machine at once when it looks for one, and on a
  busy machine one of them can overrun the eight-second window just printing its version. That
  was reported exactly like Java not being installed, so the Java on PATH could vanish from one
  look and be back the next, and the default could flip between the two. When it still does not
  answer after a second try, the message now says it was slow rather than absent.
