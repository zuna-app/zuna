/**
 * Uploads a FormData payload via XHR, reporting upload progress.
 * Shared between conversation and channel attachment flows.
 *
 * @returns The `attachment_id` returned by the server on success.
 */
export function xhrUpload(
  url: string,
  token: string,
  formData: FormData,
  onProgress: (pct: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status === 201) {
        try {
          const response = JSON.parse(xhr.responseText) as {
            attachment_id: string;
          };
          resolve(response.attachment_id);
        } catch {
          reject(new Error("Invalid upload response"));
        }
      } else {
        reject(new Error(`Upload failed: ${xhr.status}`));
      }
    });

    xhr.addEventListener("error", () => reject(new Error("Upload failed")));
    xhr.send(formData);
  });
}
