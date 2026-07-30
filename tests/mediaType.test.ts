import { describe, expect, it } from "bun:test";
import { getMediaType } from "../src/utils/mediaType";

describe("getMediaType", () => {
    it("restores extension-aware upload metadata from the former Bun runtime", () => {
        expect(getMediaType("photo.JPG")).toBe("image/jpeg");
        expect(getMediaType("report.pdf")).toBe("application/pdf");
        expect(getMediaType("notes.txt")).toBe("text/plain");
        expect(getMediaType("archive.unknown-extension")).toBe("application/octet-stream");
    });
});
