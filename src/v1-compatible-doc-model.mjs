import { createHash } from "node:crypto";
import { isStructuredHeading } from "./structured-doc-source.mjs";

function sha256(value) {
  return createHash("sha256")
    .update(String(value), "utf8")
    .digest("hex");
}

export function normalizeV1Literal(value) {
  return String(value ?? "")
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ")
    .trim();
}

export function v1CompatibleStableRef(
  code,
  item
) {
  const prefix =
    code +
    ":section:" +
    String(
      item.sectionOrdinal
    ).padStart(3, "0");

  return item.kind === "section"
    ? prefix
    : prefix +
      ":atom:" +
      String(
        item.atomOrdinal
      ).padStart(4, "0");
}

export function buildV1CompatibleParagraphModel(
  paragraphs,
  code
) {
  const soslCode =
    String(code ?? "").trim();

  if (!soslCode) {
    throw new Error(
      "sosl_code missing"
    );
  }

  if (!Array.isArray(paragraphs)) {
    throw new Error(
      soslCode +
      ": paragraphs missing"
    );
  }

  const items = [];
  let sectionOrdinal = 0;
  let atomOrdinal = 0;
  let section = null;
  let ordinal = 0;

  for (const paragraph of paragraphs) {
    const text =
      normalizeV1Literal(
        paragraph?.text
      );

    if (!text) continue;

    const opensSection =
      sectionOrdinal === 0 ||
      isStructuredHeading({
        ...paragraph,
        text
      });

    if (opensSection) {
      sectionOrdinal += 1;
      atomOrdinal = 0;
      section = text;

      const item = {
        kind: "section",
        section,
        sectionOrdinal,
        atomOrdinal: 0,
        ordinal: ordinal++,
        text,
        startIndex:
          paragraph?.startIndex ??
          null,
        endIndex:
          paragraph?.endIndex ??
          null
      };

      item.stable_ref =
        v1CompatibleStableRef(
          soslCode,
          item
        );

      item.content_hash =
        sha256(text);

      items.push(item);
      continue;
    }

    atomOrdinal += 1;

    const item = {
      kind: "atom",
      section,
      sectionOrdinal,
      atomOrdinal,
      ordinal: ordinal++,
      text,
      startIndex:
        paragraph?.startIndex ??
        null,
      endIndex:
        paragraph?.endIndex ??
        null
    };

    item.stable_ref =
      v1CompatibleStableRef(
        soslCode,
        item
      );

    item.content_hash =
      sha256(text);

    items.push(item);
  }

  if (!items.length) {
    throw new Error(
      soslCode +
      ": empty document"
    );
  }

  const canonical =
    items
      .map(
        item =>
          item.kind +
          "\u001f" +
          item.section +
          "\u001f" +
          item.text
      )
      .join("\u001e");

  return {
    sosl_code:
      soslCode,
    granularity:
      "section_plus_paragraph_atom_v2",
    items,
    content_units:
      items.length,
    hash:
      sha256(canonical)
  };
}
