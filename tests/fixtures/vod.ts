export class VodService {
  constructor(public options: unknown) {}
  async UploadMedia(_input: unknown): Promise<any> { throw Error("unmocked VOD upload forbidden"); }
}
