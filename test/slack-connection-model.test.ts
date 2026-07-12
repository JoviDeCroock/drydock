import { describe, expect, test } from "vitest";
import { getSavedSlackChannelOption } from "../src/models/slack-connection";

const connection = {
  teamId: "T123",
  teamName: "Drydock",
  channelId: "C_RELEASES",
  channelName: "package-releases",
  canListChannels: true,
  enabled: true,
  createdAt: "2026-07-12T00:00:00.000Z",
};

describe("getSavedSlackChannelOption", () => {
  test("keeps the saved channel available while the channel list loads", () => {
    expect(getSavedSlackChannelOption(connection)).toEqual({
      id: "C_RELEASES",
      name: "package-releases",
    });
  });

  test("does not invent an option for a manually entered channel ID", () => {
    expect(getSavedSlackChannelOption({ ...connection, channelName: null })).toBeNull();
  });
});
