/* 設定 view: workspace (shared) code for real-time sales sync, and legacy local-sales upload. */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const workspaceCodeDisplay = $('workspace-code-display');
  const workspaceCodeCopyButton = $('workspace-code-copy');
  const workspaceCodeJoinButton = $('workspace-code-join');
  const workspaceMigrateButton = $('workspace-migrate-button');
  const workspaceMessage = $('workspace-message');

  function showWorkspaceMessage(message, isError = false) {
    workspaceMessage.textContent = message;
    workspaceMessage.classList.toggle('is-error', isError);
  }

  function renderWorkspaceCode() {
    workspaceCodeDisplay.textContent = window.Cloud.getWorkspaceId();
  }

  workspaceCodeCopyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.Cloud.getWorkspaceId());
      showWorkspaceMessage('共有コードをコピーしました。');
    } catch (err) {
      console.error(err);
      showWorkspaceMessage('コピーに失敗しました。手動で選択してコピーしてください。', true);
    }
  });

  workspaceCodeJoinButton.addEventListener('click', () => {
    const input = window.prompt('参加する共有コードを入力してください(他の端末に表示されているコード):', '');
    if (input == null) return;
    const clean = input.trim();
    if (!clean) return;
    window.Cloud.setWorkspaceId(clean);
    showWorkspaceMessage('共有コードを変更しました。反映のためページを再読み込みします…');
    setTimeout(() => location.reload(), 800);
  });

  workspaceMigrateButton.addEventListener('click', async () => {
    const ok = window.confirm(
      'この端末にローカル保存されている過去の売上データを、現在の共有コードのクラウドにアップロードします。' +
      '在庫数は変更されません。同じデータを2回アップロードすると重複するのでご注意ください。続けますか?'
    );
    if (!ok) return;

    workspaceMigrateButton.disabled = true;
    try {
      const localSales = await window.LegacyLocalSalesDB.getAll();
      if (localSales.length === 0) {
        showWorkspaceMessage('アップロード対象のローカル売上データはありませんでした。');
        return;
      }
      await window.SalesDB.bulkImport(localSales);
      showWorkspaceMessage(`${localSales.length}件のローカル売上データをアップロードしました。`);
    } catch (err) {
      console.error(err);
      showWorkspaceMessage('アップロードに失敗しました: ' + err.message, true);
    } finally {
      workspaceMigrateButton.disabled = false;
    }
  });

  // ---------- One-time upload of this device's old local product master to the cloud ----------

  const productUploadButton = $('product-upload-button');
  let uploading = false;

  async function uploadLocalProducts() {
    if (uploading) return;
    const localCount = (await window.LocalProductDB.getAll()).length;
    if (localCount === 0) {
      window.App.showToast('この端末には、アップロードする商品がありません。');
      return;
    }
    const ok = window.confirm(
      `この端末の商品マスタ(${localCount}件)を、共有コード「${window.Cloud.getWorkspaceId()}」のクラウドへアップロードします。` +
      '在庫数もそのまま引き継ぎます。商品コードが同じ商品がすでにクラウドにある場合は、その商品は上げません(重複防止)。続けますか?'
    );
    if (!ok) return;
    uploading = true;
    productUploadButton.disabled = true;
    try {
      const { added, skipped } = await window.ProductDB.uploadLocalProducts();
      window.App.showToast(`${added}件の商品をクラウドへアップロードしました${skipped ? `(${skipped}件は商品コードが同じため省略)` : ''}。`);
      await window.RegisterView?.reloadProducts();
      window.ProductsView?.refreshList();
      window.ProductsView?.renderCloudBanner();
    } catch (err) {
      console.error(err);
      window.App.showToast('アップロードに失敗しました: ' + err.message, true);
    } finally {
      uploading = false;
      productUploadButton.disabled = false;
    }
  }

  productUploadButton.addEventListener('click', uploadLocalProducts);
  window.SettingsView = { uploadLocalProducts };

  // ---------- お預かりボタンの金額 (per device; stored by js/register.js) ----------

  const tenderForm = $('tender-settings-form');
  const tenderInput = $('tender-amounts-input');
  const tenderPreview = $('tender-amounts-preview');
  const tenderReset = $('tender-amounts-reset');
  const tenderMessage = $('tender-settings-message');

  function showTenderMessage(message, isError = false) {
    tenderMessage.textContent = message;
    tenderMessage.classList.toggle('is-error', isError);
  }

  function renderTenderPreview(amounts) {
    const fmt = (n) => window.App.formatCurrency(n);
    tenderPreview.innerHTML = '<span class="tender-chip tender-chip--exact">ちょうど</span>' +
      amounts.map((n) => `<span class="tender-chip">+${fmt(n)}</span>`).join('');
  }

  function loadTenderSettings() {
    const amounts = window.RegisterView.getTenderAmounts();
    tenderInput.value = amounts.join(', ');
    renderTenderPreview(amounts);
    showTenderMessage('');
  }

  tenderInput.addEventListener('input', () => {
    renderTenderPreview(window.RegisterView.parseTenderAmounts(tenderInput.value));
    showTenderMessage('');
  });

  tenderForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const amounts = window.RegisterView.parseTenderAmounts(tenderInput.value);
    if (amounts.length === 0) {
      showTenderMessage('金額を1つ以上入力してください(例: 300, 500, 1000)。', true);
      return;
    }
    const saved = window.RegisterView.setTenderAmounts(amounts);
    tenderInput.value = saved.join(', ');
    renderTenderPreview(saved);
    showTenderMessage('保存しました。次の会計から反映されます。');
  });

  tenderReset.addEventListener('click', () => {
    const saved = window.RegisterView.setTenderAmounts([]);
    tenderInput.value = saved.join(', ');
    renderTenderPreview(saved);
    showTenderMessage('初期値に戻しました。');
  });

  window.Router.onViewActivate('settings', () => {
    renderWorkspaceCode();
    loadTenderSettings();
  });
})();
