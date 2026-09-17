import Foundation

private enum BenchmarkReceiptError: LocalizedError {
  case invalidJSON
  case tooLarge

  var errorDescription: String? {
    switch self {
    case .invalidJSON:
      return "benchmark receipt must be a JSON object"
    case .tooLarge:
      return "benchmark receipt exceeds the 8 MiB safety limit"
    }
  }
}

enum BenchmarkReceiptWriter {
  static func write(_ receipt: String, to documents: URL) throws -> String {
    let data = Data(receipt.utf8)
    guard data.count <= 8 * 1024 * 1024 else { throw BenchmarkReceiptError.tooLarge }
    guard let object = try? JSONSerialization.jsonObject(with: data),
          let receiptObject = object as? [String: Any]
    else { throw BenchmarkReceiptError.invalidJSON }

    let filename: String
    switch receiptObject["contract"] as? String {
    case "rustra-nitro-parity/v1", "rustra-nitro-parity/v2":
      filename = "rustra-nitro-parity.json"
    default:
      filename = "rustra-benchmark-receipt.json"
    }
    let destination = documents.appendingPathComponent(filename)
    try data.write(to: destination, options: .atomic)
    return destination.lastPathComponent
  }
}
