/** Any /api path no route claims answers JSON, never the website's index.html. */
export async function notFoundHandler() {
  return { status: 404, body: { message: "Not found." } };
}
