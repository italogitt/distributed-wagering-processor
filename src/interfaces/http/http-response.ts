/** O pedaço da resposta do Express que usamos (o projeto não depende de @types/express). */
export interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): void;
}
