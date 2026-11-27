export type BatchCancelItem = {
  id: string;
  orderNo: string;
  carrierTrackingNumber?: string | null;
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';
  error?: string;
};

export async function cancelOrdersSequentially(
  selected: BatchCancelItem[],
  cancel: (item: BatchCancelItem) => Promise<void>,
  onProgress: (items: BatchCancelItem[]) => void,
): Promise<BatchCancelItem[]> {
  const results: BatchCancelItem[] = selected.map((item) => ({ ...item, status: 'PENDING' }));
  onProgress([...results]);
  for (let index = 0; index < results.length; index++) {
    results[index] = { ...results[index]!, status: 'RUNNING' };
    onProgress([...results]);
    try {
      await cancel(results[index]!);
      results[index] = { ...results[index]!, status: 'SUCCESS' };
    } catch (error) {
      results[index] = { ...results[index]!, status: 'FAILED', error: error instanceof Error ? error.message : String(error) };
    }
    onProgress([...results]);
  }
  return results;
}
