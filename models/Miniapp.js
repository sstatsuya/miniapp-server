const mongoose = require("mongoose");

const miniappVersionSchema = new mongoose.Schema(
  {
    version: {
      type: String,
      required: true,
      match: /^\d+\.\d+\.\d+$/,
    },
    bundleUrl: {
      type: String,
      required: true,
    },
    createAt: {
      type: Date,
      required: true,
    },
    isActive: {
      type: Boolean,
      required: true,
      default: false,
    },
  },
  { _id: false }
);

const miniappSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  createAt: {
    type: Date,
    required: true,
  },
  data: {
    type: [miniappVersionSchema],
    required: true,
    default: [],
  },
});

module.exports = mongoose.model("Miniapp", miniappSchema, "miniapp");
