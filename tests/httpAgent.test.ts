import { describe, expect, it } from "bun:test";
import {
    getRecommendedSocketLimit,
    inferNetworkProfile,
    MAX_PARALLEL_FILE_TRANSFERS,
    NETWORK_PROFILE_SETTINGS,
} from "../src/utils/httpAgent";

describe("Network performance profiles", () => {
    it("matches application concurrency to the SDK file queue", () => {
        expect(MAX_PARALLEL_FILE_TRANSFERS).toBe(5);
        expect(NETWORK_PROFILE_SETTINGS.safe).toEqual({
            concurrency: 1,
            maxSockets: 2,
            wifiSafeMode: true,
        });
        expect(NETWORK_PROFILE_SETTINGS.balanced.maxSockets).toBe(8);
        expect(NETWORK_PROFILE_SETTINGS.performance.maxSockets).toBe(16);
    });

    it("maps custom concurrency to bounded socket pools", () => {
        expect(getRecommendedSocketLimit(1, false)).toBe(4);
        expect(getRecommendedSocketLimit(2, false)).toBe(6);
        expect(getRecommendedSocketLimit(3, false)).toBe(8);
        expect(getRecommendedSocketLimit(4, false)).toBe(12);
        expect(getRecommendedSocketLimit(5, false)).toBe(16);
        expect(getRecommendedSocketLimit(5, true)).toBe(2);
    });

    it("infers named profiles only for their exact settings", () => {
        expect(inferNetworkProfile(1, true)).toBe("safe");
        expect(inferNetworkProfile(3, false)).toBe("balanced");
        expect(inferNetworkProfile(5, false)).toBe("performance");
        expect(inferNetworkProfile(2, false)).toBe("custom");
    });
});
