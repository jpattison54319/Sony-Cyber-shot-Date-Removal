import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";
export const dynamic = "force-static";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#f8b56f",
          background: "#23251f",
          borderRadius: 14,
          fontFamily: "monospace",
          fontSize: 25,
          fontWeight: 800,
        }}
      >
        08
      </div>
    ),
    size,
  );
}
