// Walk the canvas tree and emit QML source for the renderer + .lgx export.
// Targets Basecamp's allowed sandbox: QtQuick / Controls 2.15 / Layouts 1.15.
//
// Layout model: every node emits explicit x/y/width/height (px). Every node
// also carries a CommonStyle wrapper (background colour, border, radius,
// opacity, rotation) which becomes the outer Rectangle in QML; type-specific
// content (Text / Button) anchors inside that wrapper. Frames are bare
// Rectangles holding child nodes directly.
//
// This keeps the generated QML uniform: each editor node = one outer
// Rectangle, what-you-see ≈ what-renders.

import { CommonStyle, ImageFit, Node } from "./types";

const escapeStr = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

const indent = (depth: number) => "    ".repeat(depth);

// CommonStyle → QML property lines (without the geometry — caller emits that).
const styleLines = (s: CommonStyle, i: string): string[] => {
  const lines: string[] = [
    `${i}    color: '${escapeStr(s.backgroundColor)}'`,
    `${i}    radius: ${s.borderRadius}`,
  ];
  if (s.borderWidth > 0) {
    lines.push(`${i}    border.color: '${escapeStr(s.borderColor)}'`);
    lines.push(`${i}    border.width: ${s.borderWidth}`);
  }
  if (s.opacity !== 1) lines.push(`${i}    opacity: ${s.opacity}`);
  if (s.rotation !== 0) lines.push(`${i}    rotation: ${s.rotation}`);
  return lines;
};

const geomLines = (n: Node, i: string): string[] => [
  `${i}    x: ${n.x}`,
  `${i}    y: ${n.y}`,
  `${i}    width: ${n.width}`,
  `${i}    height: ${n.height}`,
];

const textAlignToQml = (a: "left" | "center" | "right") =>
  a === "left" ? "Text.AlignLeft" : a === "right" ? "Text.AlignRight" : "Text.AlignHCenter";

const fontWeightToQml = (w: "normal" | "bold") =>
  w === "bold" ? "Font.Bold" : "Font.Normal";

// CSS object-fit → Qt Image.fillMode (closest equivalent for each).
const fitToQml = (f: ImageFit): string => {
  switch (f) {
    case "fill":        return "Image.Stretch";
    case "contain":     return "Image.PreserveAspectFit";
    case "cover":       return "Image.PreserveAspectCrop";
    case "none":        return "Image.Pad";
    case "scale-down":  return "Image.PreserveAspectFit"; // PreserveAspectFit
                                                          // already only
                                                          // shrinks, doesn't
                                                          // scale up.
  }
};

const emitNode = (node: Node, depth: number): string => {
  const i = indent(depth);

  switch (node.kind) {
    case "Frame": {
      const lines = [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
      ];
      // Hidden children are excluded from the emitted QML — the .lgx
      // shouldn't ship things the user has toggled invisible in the editor.
      for (const c of node.children) {
        if (c.hidden) continue;
        lines.push(emitNode(c, depth + 1));
      }
      lines.push(`${i}}`);
      return lines.join("\n");
    }

    case "Rectangle": {
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        `${i}}`,
      ].join("\n");
    }

    case "Text": {
      const inner: (string | null)[] = [
        `${i}    Text {`,
        `${i}        anchors.fill: parent`,
        `${i}        text: '${escapeStr(node.text)}'`,
        `${i}        font.pixelSize: ${node.pixelSize}`,
        `${i}        color: '${escapeStr(node.color)}'`,
        `${i}        font.weight: ${fontWeightToQml(node.fontWeight)}`,
        node.italic ? `${i}        font.italic: true` : null,
        `${i}        horizontalAlignment: ${textAlignToQml(node.textAlign)}`,
        `${i}        verticalAlignment: Text.AlignVCenter`,
        node.fontFamily ? `${i}        font.family: '${escapeStr(node.fontFamily)}'` : null,
        node.letterSpacing !== 0 ? `${i}        font.letterSpacing: ${node.letterSpacing}` : null,
        node.lineHeight !== 1 ? `${i}        lineHeight: ${node.lineHeight}` : null,
        node.lineHeight !== 1 ? `${i}        lineHeightMode: Text.ProportionalHeight` : null,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner.filter((l): l is string => l !== null),
        `${i}}`,
      ].join("\n");
    }

    case "Button": {
      const inner: string[] = [
        `${i}    Button {`,
        `${i}        anchors.fill: parent`,
        `${i}        text: '${escapeStr(node.text)}'`,
        `${i}        contentItem: Text {`,
        `${i}            text: '${escapeStr(node.text)}'`,
        `${i}            color: '${escapeStr(node.textColor)}'`,
        `${i}            font.weight: ${fontWeightToQml(node.fontWeight)}`,
        `${i}            horizontalAlignment: Text.AlignHCenter`,
        `${i}            verticalAlignment: Text.AlignVCenter`,
        `${i}        }`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner,
        `${i}}`,
      ].join("\n");
    }

    case "Image": {
      const inner: string[] = [
        `${i}    Image {`,
        `${i}        anchors.fill: parent`,
        `${i}        source: '${escapeStr(node.src)}'`,
        `${i}        fillMode: ${fitToQml(node.fit)}`,
        `${i}        clip: true`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner,
        `${i}}`,
      ].join("\n");
    }

    case "TextField": {
      const inner: string[] = [
        `${i}    TextField {`,
        `${i}        anchors.fill: parent`,
        `${i}        text: '${escapeStr(node.text)}'`,
        `${i}        placeholderText: '${escapeStr(node.placeholder)}'`,
        `${i}        readOnly: ${node.readOnly}`,
        `${i}        font.pixelSize: ${node.pixelSize}`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner,
        `${i}}`,
      ].join("\n");
    }

    case "CheckBox": {
      const inner: string[] = [
        `${i}    CheckBox {`,
        `${i}        anchors.fill: parent`,
        `${i}        text: '${escapeStr(node.text)}'`,
        `${i}        checked: ${node.checked}`,
        `${i}        font.pixelSize: ${node.pixelSize}`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner,
        `${i}}`,
      ].join("\n");
    }

    case "Switch": {
      const inner: string[] = [
        `${i}    Switch {`,
        `${i}        anchors.fill: parent`,
        `${i}        text: '${escapeStr(node.text)}'`,
        `${i}        checked: ${node.checked}`,
        `${i}        font.pixelSize: ${node.pixelSize}`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner,
        `${i}}`,
      ].join("\n");
    }

    case "Slider": {
      const inner: string[] = [
        `${i}    Slider {`,
        `${i}        anchors.fill: parent`,
        `${i}        from: ${node.from}`,
        `${i}        to: ${node.to}`,
        `${i}        value: ${node.value}`,
        `${i}        stepSize: ${node.stepSize}`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner,
        `${i}}`,
      ].join("\n");
    }

    case "ProgressBar": {
      const inner: string[] = [
        `${i}    ProgressBar {`,
        `${i}        anchors.fill: parent`,
        `${i}        from: ${node.from}`,
        `${i}        to: ${node.to}`,
        `${i}        value: ${node.value}`,
        `${i}        indeterminate: ${node.indeterminate}`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner,
        `${i}}`,
      ].join("\n");
    }

    case "TextArea": {
      const wrap = node.wrapMode === "word"
        ? "TextEdit.WordWrap"
        : "TextEdit.NoWrap";
      const inner: string[] = [
        `${i}    ScrollView {`,
        `${i}        anchors.fill: parent`,
        `${i}        TextArea {`,
        `${i}            text: '${escapeStr(node.text)}'`,
        `${i}            placeholderText: '${escapeStr(node.placeholder)}'`,
        `${i}            readOnly: ${node.readOnly}`,
        `${i}            font.pixelSize: ${node.pixelSize}`,
        `${i}            wrapMode: ${wrap}`,
        `${i}        }`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner,
        `${i}}`,
      ].join("\n");
    }

    case "RadioButton": {
      const inner: string[] = [
        `${i}    RadioButton {`,
        `${i}        anchors.fill: parent`,
        `${i}        text: '${escapeStr(node.text)}'`,
        `${i}        checked: ${node.checked}`,
        `${i}        font.pixelSize: ${node.pixelSize}`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner,
        `${i}}`,
      ].join("\n");
    }

    case "SpinBox": {
      const inner: string[] = [
        `${i}    SpinBox {`,
        `${i}        anchors.fill: parent`,
        `${i}        from: ${node.from}`,
        `${i}        to: ${node.to}`,
        `${i}        value: ${node.value}`,
        `${i}        stepSize: ${node.stepSize}`,
        `${i}        editable: ${node.editable}`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner,
        `${i}}`,
      ].join("\n");
    }

    case "BusyIndicator": {
      const inner: string[] = [
        `${i}    BusyIndicator {`,
        `${i}        anchors.fill: parent`,
        `${i}        running: ${node.running}`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner,
        `${i}}`,
      ].join("\n");
    }

    case "ComboBox": {
      const modelLiteral =
        "[" + node.model.map((m) => `'${escapeStr(m)}'`).join(", ") + "]";
      const inner: string[] = [
        `${i}    ComboBox {`,
        `${i}        anchors.fill: parent`,
        `${i}        model: ${modelLiteral}`,
        `${i}        currentIndex: ${node.currentIndex}`,
        `${i}        font.pixelSize: ${node.pixelSize}`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner,
        `${i}}`,
      ].join("\n");
    }

    case "AnimatedImage": {
      const inner: string[] = [
        `${i}    AnimatedImage {`,
        `${i}        anchors.fill: parent`,
        `${i}        source: '${escapeStr(node.src)}'`,
        `${i}        fillMode: ${fitToQml(node.fit)}`,
        `${i}        playing: ${node.playing}`,
        `${i}        clip: true`,
        `${i}    }`,
      ];
      return [
        `${i}Rectangle {`,
        ...geomLines(node, i),
        ...styleLines(node.style, i),
        ...inner,
        `${i}}`,
      ].join("\n");
    }
  }
};

// Emit a Main.qml ready for either the live preview (no imports — the
// renderer prepends them) or the .lgx export (with imports). Pass
// `forExport: true` for the latter.
export const emitMainQml = (root: Node, forExport: boolean): string => {
  const body = emitNode(root, 0);
  if (!forExport) return body;
  const imports = [
    "import QtQuick 2.15",
    "import QtQuick.Controls 2.15",
    "import QtQuick.Layouts 1.15",
    "",
  ].join("\n");
  return imports + "\n" + body + "\n";
};
