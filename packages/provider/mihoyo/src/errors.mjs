export class MihoyoError extends Error {
  constructor(code, publicMessage, retcode) {
    super(code);
    this.name = "MihoyoError";
    this.code = code;
    this.publicMessage = publicMessage;
    this.retcode = retcode;
  }
}
