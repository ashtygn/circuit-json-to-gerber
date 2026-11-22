import { expect, test } from "bun:test"
import {
  pcb_smtpad,
  pcb_solder_paste,
  type AnyCircuitElement,
} from "circuit-json"
import { convertCircuitJsonToGerberFiles } from "src/convert-circuit-json-to-gerber-files"
import { convertCircuitJsonToGerberCommands } from "src/gerber/convert-soup-to-gerber-commands"
import { renderGerberFileSvg } from "tests/fixtures/render-gerber-file-svg"
import {
  expectOtherFilesUnchanged,
  regionPoints,
} from "tests/fixtures/soldermask-opening"

const board: AnyCircuitElement = {
  type: "pcb_board",
  pcb_board_id: "board",
  center: { x: 0, y: 0 },
  width: 16,
  height: 10,
  num_layers: 2,
  thickness: 1.6,
  material: "fr4",
}

const cases = (["rotated_rect", "rotated_pill"] as const).flatMap((shape) =>
  [30, 90, -45, 270].flatMap((rotation) =>
    ["top", "bottom"].flatMap((layer) =>
      [false, true].flatMap((flip_y_axis) =>
        [false, true].map((tall) => ({
          shape,
          rotation,
          layer,
          flip_y_axis,
          width: tall ? 1.1 : 2.4,
          height: tall ? 2.4 : 1.1,
        })),
      ),
    ),
  ),
)

// These assert the intended output; test.failing keeps the reproduction green.
test.failing.each(cases)(
  "$shape $rotation degrees, $layer, flip=$flip_y_axis, $width x $height needs no LR",
  async ({ shape, rotation, layer, flip_y_axis, width, height }) => {
    const center = { x: 1.25, y: -0.75 }
    const paste = pcb_solder_paste.parse({
      type: "pcb_solder_paste",
      pcb_solder_paste_id: "paste",
      shape,
      layer,
      width,
      height,
      radius: Math.min(width, height) / 2,
      ccw_rotation: rotation,
      ...center,
    })
    const followingPaste = pcb_solder_paste.parse({
      type: "pcb_solder_paste",
      shape: "rect",
      layer,
      width: 0.6,
      height: 0.4,
      x: 5,
      y: 3,
    })
    const circuitJson = [board, paste, followingPaste]
    const original = structuredClone(circuitJson)
    const layerName = layer === "top" ? "F_Paste" : "B_Paste"
    const options = { flip_y_axis }
    const files = convertCircuitJsonToGerberFiles(circuitJson, options)
    expect(files[`${layerName}.gbr`]).not.toContain("%LR")

    // Check actual coordinates, including rotation direction and Y reflection.
    const radians = (rotation * Math.PI) / 180
    const rotate = ([x, y]: number[]) => ({
      x: center.x + x * Math.cos(radians) - y * Math.sin(radians),
      y:
        (center.y + x * Math.sin(radians) + y * Math.cos(radians)) *
        (flip_y_axis ? -1 : 1),
    })
    const offset = Math.abs(width - height) / 2
    const corners = [
      [-width / 2, height / 2],
      [width / 2, height / 2],
      [width / 2, -height / 2],
      [-width / 2, -height / 2],
      [-width / 2, height / 2],
    ]
    const ends =
      width > height
        ? [
            [-offset, 0],
            [offset, 0],
          ]
        : [
            [0, -offset],
            [0, offset],
          ]
    const commands = convertCircuitJsonToGerberCommands(circuitJson, options)
    const points = regionPoints(commands[layerName])
    const expected = (shape === "rotated_rect" ? corners : ends).map(rotate)
    expect(points).toHaveLength(expected.length)
    for (const [i, point] of points.entries()) {
      expect(point.x).toBeCloseTo(expected[i].x, 8)
      expect(point.y).toBeCloseTo(expected[i].y, 8)
    }

    // Read the serialized file independently, with no snapshot LR compensation.
    const singlePaste = convertCircuitJsonToGerberFiles([board, paste], options)
    const { viewBox } = await renderGerberFileSvg(
      singlePaste[`${layerName}.gbr`],
      "rotated-paste",
      "#999999",
    )
    const minor = Math.min(width, height)
    const expectedWidth =
      shape === "rotated_rect"
        ? width * Math.abs(Math.cos(radians)) +
          height * Math.abs(Math.sin(radians))
        : minor +
          Math.abs(ends[1][0] - ends[0][0]) * Math.abs(Math.cos(radians)) +
          Math.abs(ends[1][1] - ends[0][1]) * Math.abs(Math.sin(radians))
    const expectedHeight =
      shape === "rotated_rect"
        ? width * Math.abs(Math.sin(radians)) +
          height * Math.abs(Math.cos(radians))
        : minor +
          Math.abs(ends[1][0] - ends[0][0]) * Math.abs(Math.sin(radians)) +
          Math.abs(ends[1][1] - ends[0][1]) * Math.abs(Math.cos(radians))
    expect(viewBox[2]).toBeCloseTo(expectedWidth * 1000, 2)
    expect(viewBox[3]).toBeCloseTo(expectedHeight * 1000, 2)
    expect(viewBox[0] + viewBox[2] / 2).toBeCloseTo(center.x * 1000, 2)
    expect(viewBox[1] + viewBox[3] / 2).toBeCloseTo(
      center.y * 1000 * (flip_y_axis ? -1 : 1),
      2,
    )
    const followingFlash = commands[layerName]
      .filter((command) => command.command_code === "D03")
      .at(-1)
    expect(followingFlash).toEqual({
      command_code: "D03",
      x: 5,
      y: flip_y_axis ? -3 : 3,
    })
    expectOtherFilesUnchanged(
      files,
      convertCircuitJsonToGerberFiles(
        [
          board,
          pcb_solder_paste.parse({ ...paste, ccw_rotation: 0 }),
          followingPaste,
        ],
        options,
      ),
      `${layerName}.gbr`,
    )
    expect(circuitJson).toEqual(original)
  },
)

for (const layer of ["top", "bottom"] as const) {
  for (const flip_y_axis of [false, true]) {
    test(`raw paste over copper: ${layer}, flip=${flip_y_axis}`, async () => {
      const circuitJson: AnyCircuitElement[] = [board]
      for (const [row, shape] of (
        ["rotated_rect", "rotated_pill"] as const
      ).entries()) {
        for (const [column, rotation] of [0, 30, 90, -45].entries()) {
          const geometry = {
            shape,
            layer,
            x: -5.25 + column * 3.5,
            y: 2 - row * 4,
            ccw_rotation: rotation,
          }
          circuitJson.push(
            pcb_smtpad.parse({
              type: "pcb_smtpad",
              pcb_smtpad_id: `pad_${row}_${column}`,
              ...geometry,
              width: 2.4,
              height: 1.1,
              radius: 0.55,
            }),
            pcb_solder_paste.parse({
              type: "pcb_solder_paste",
              pcb_solder_paste_id: `paste_${row}_${column}`,
              ...geometry,
              width: 2.4 * 0.7,
              height: 1.1 * 0.7,
              radius: 0.55 * 0.7,
            }),
          )
        }
      }
      const files = convertCircuitJsonToGerberFiles(circuitJson, {
        flip_y_axis,
      })
      const copper = layer === "top" ? "F_Cu" : "B_Cu"
      const paste = layer === "top" ? "F_Paste" : "B_Paste"
      // Raw layer overlay deliberately bypasses the stackup helper's LR shim.
      await expect({
        [copper]: files[`${copper}.gbr`],
        [paste]: files[`${paste}.gbr`],
      }).toMatchGerberLayerOverlaySnapshot(
        import.meta.path,
        `paste-without-lr-${layer}-${flip_y_axis ? "reflected" : "normal"}`,
        [copper, paste],
        {
          colors: { [copper]: "#c99b35", [paste]: "#b8b8b8" },
          backgroundColor: "#111111",
        },
      )
    })
  }
}
