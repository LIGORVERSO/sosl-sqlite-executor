import { createHash } from "node:crypto";

function sha256(value) {
  return createHash("sha256")
    .update(String(value), "utf8")
    .digest("hex");
}

function paragraphText(paragraph) {
  return (paragraph?.elements ?? [])
    .map(element => element?.textRun?.content ?? "")
    .join("")
    .replace(/\n+$/g, "")
    .trim();
}

function collectBody(body, out) {
  for (const item of body?.content ?? []) {
    if (item?.paragraph) {
      const text = paragraphText(item.paragraph);
      if (text) {
        out.push({
          text,
          style:
            item.paragraph?.paragraphStyle
              ?.namedStyleType ??
            "NORMAL_TEXT",
          startIndex:
            item.startIndex ?? null,
          endIndex:
            item.endIndex ?? null
        });
      }
    }

    if (item?.table?.tableRows) {
      for (const row of item.table.tableRows) {
        for (const cell of row.tableCells ?? []) {
          collectBody(
            {content: cell.content ?? []},
            out
          );
        }
      }
    }
  }
}

function collectTabs(tabs, out) {
  for (const tab of tabs ?? []) {
    collectBody(
      tab?.documentTab?.body,
      out
    );
    collectTabs(
      tab?.childTabs,
      out
    );
  }
}

export function extractStyledParagraphs(document) {
  const out = [];

  if (
    Array.isArray(document?.tabs) &&
    document.tabs.length
  ) {
    collectTabs(
      document.tabs,
      out
    );
  } else {
    collectBody(
      document?.body,
      out
    );
  }

  return out;
}

export function isStructuredHeading(paragraph) {
  if (
    /^(TITLE|SUBTITLE|HEADING_\d+)$/i.test(
      paragraph?.style ?? ""
    )
  ) {
    return true;
  }

  const text =
    String(
      paragraph?.text ?? ""
    ).trim();

  return (
    /^\d+(?:\.\d+)*[.)]?\s+\S/.test(text) ||
    /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ0-9 /–—_:-]{4,100}$/.test(text)
  );
}

export function observeStyledDocumentWithToken({
  source,
  accessToken,
  fetchImpl = fetch
}) {
  const driveMeta =
    async () => {
      const url =
        "https://www.googleapis.com/drive/v3/files/" +
        encodeURIComponent(
          source.drive_file_id
        ) +
        "?fields=id,name,mimeType,version,modifiedTime,trashed&supportsAllDrives=true";

      const response =
        await fetchImpl(url, {
          headers: {
            authorization:
              "Bearer " + accessToken
          }
        });

      const body =
        await response
          .json()
          .catch(() => ({}));

      if (
        !response.ok ||
        body.id !==
          source.drive_file_id ||
        body.trashed === true ||
        body.mimeType !==
          "application/vnd.google-apps.document" ||
        !body.version ||
        !body.modifiedTime
      ) {
        throw new Error(
          source.sosl_code +
          ": invalid readonly metadata"
        );
      }

      return body;
    };

  const documentJson =
    async () => {
      const url =
        "https://docs.googleapis.com/v1/documents/" +
        encodeURIComponent(
          source.drive_file_id
        ) +
        "?includeTabsContent=true";

      const response =
        await fetchImpl(url, {
          headers: {
            authorization:
              "Bearer " + accessToken
          }
        });

      const body =
        await response
          .json()
          .catch(() => ({}));

      if (
        !response.ok ||
        body.documentId !==
          source.drive_file_id
      ) {
        throw new Error(
          source.sosl_code +
          ": readonly document fetch failed"
        );
      }

      return body;
    };

  return (async () => {
    const before =
      await driveMeta();

    const document =
      await documentJson();

    const after =
      await driveMeta();

    if (
      String(before.version) !==
        String(after.version) ||
      before.modifiedTime !==
        after.modifiedTime ||
      before.trashed === true ||
      after.trashed === true
    ) {
      throw new Error(
        source.sosl_code +
        ": revision changed during read"
      );
    }

    return {
      sosl_code:
        source.sosl_code,
      drive_file_id:
        source.drive_file_id,
      title:
        after.name ||
        source.sosl_code,
      mime_type:
        after.mimeType,
      version:
        String(after.version),
      modified_time:
        after.modifiedTime,
      paragraphs:
        extractStyledParagraphs(
          document
        ),
      document
    };
  })();
}
