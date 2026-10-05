const Database = require('better-sqlite3');

// ===================== 1. 分析备份文件 =====================
console.log('=============================================');
console.log('       备份文件: delta-20260715-175426.db');
console.log('=============================================\n');

const backupDb = new Database('./backups/delta-20260715-175426.db', { readonly: true });

// 备份文件的所有表
const backupTables = backupDb.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all();
console.log('【备份文件】共有表：');
backupTables.forEach(t => console.log('  - ' + t.name));

// ===================== 2. 各表数据量对比 =====================
console.log('\n\n=============================================');
console.log('           各表数据量对比');
console.log('=============================================\n');

const allTableNames = [...new Set([...backupTables.map(t => t.name)])];

for (const tableName of allTableNames) {
    try {
        const backupCount = backupDb.prepare('SELECT COUNT(*) as cnt FROM ' + tableName).get().cnt;
        console.log('表: ' + tableName);
        console.log('  备份文件数据量: ' + backupCount);
    } catch(e) {
        console.log('表: ' + tableName + ' (错误: ' + e.message + ')');
    }
}

// ===================== 3. 分析 orders 状态分布 =====================
console.log('\n\n=============================================');
console.log('   备份文件中 orders 状态分布');
console.log('=============================================\n');

const backupStatus = backupDb.prepare(\"SELECT status, COUNT(*) as cnt FROM orders GROUP BY status ORDER BY status\").all();
backupStatus.forEach(s => console.log('  ' + s.status + ': ' + s.cnt + ' 条'));

// ===================== 4. 备份文件中的已结案订单详情 =====================
console.log('\n\n=============================================');
console.log('   备份文件中已结案订单的详细信息');
console.log('=============================================\n');

const completedOrders = backupDb.prepare(\"SELECT * FROM orders WHERE status IN ('completed','early_completed') ORDER BY id\").all();
console.log('【共有 ' + completedOrders.length + ' 条已结案订单】');
completedOrders.forEach(o => {
    console.log('\n  订单ID: ' + o.id);
    console.log('  客户ID: ' + o.customer_id);
    console.log('  状态: ' + o.status);
    console.log('  总Harfbux: ' + o.total_harfbux);
    console.log('  已收金额: ' + o.received_amount);
    console.log('  初始现金: ' + o.initial_cash);
    console.log('  初始资产: ' + o.initial_assets);
    console.log('  俱乐部名称: ' + o.club_name);
    console.log('  微信名: ' + o.order_wechat_name);
    console.log('  游戏ID: ' + o.order_game_id);
    console.log('  开始时间: ' + o.started_at);
    console.log('  完成时间: ' + o.completed_at);
    console.log('  备注: ' + o.notes);
});

// ===================== 5. 备份文件中 customers 的详细信息 =====================
console.log('\n\n=============================================');
console.log('   备份文件中客户的详细信息（按订单关联）');
console.log('=============================================\n');

const backupCustomers = backupDb.prepare(\"SELECT * FROM customers ORDER BY id\").all();
console.log('【共有 ' + backupCustomers.length + ' 个客户】');
backupCustomers.forEach(c => {
    console.log('\n  客户ID: ' + c.id);
    console.log('  客户编号: ' + c.customer_number);
    console.log('  微信名: ' + c.wechat_name);
    console.log('  登录方式: ' + c.login_method);
    console.log('  游戏ID: ' + c.game_id);
    console.log('  地区: ' + c.region);
    console.log('  加速位置: ' + c.acceleration_location);
    console.log('  备注: ' + c.notes);
    console.log('  创建时间: ' + c.created_at);
});

// ===================== 6. payments 和 handler_records 对比 =====================
console.log('\n\n=============================================');
console.log('   payments 表数据量');
console.log('=============================================\n');
const backupPaymentsCount = backupDb.prepare(\"SELECT COUNT(*) as cnt FROM payments\").get().cnt;
console.log('备份文件: ' + backupPaymentsCount);

const completedPayments = backupDb.prepare(\"SELECT * FROM payments WHERE status='paid' ORDER BY id\").all();
console.log('\n已支付的payments：');
completedPayments.forEach(p => {
    console.log('  payment ID: ' + p.id + ', order_id: ' + p.order_id + ', date: ' + p.date + ', amount: ' + p.amount);
});

console.log('\nhandler_records 表数据量');
const backupHandlerCount = backupDb.prepare(\"SELECT COUNT(*) as cnt FROM handler_records\").get().cnt;
console.log('备份文件: ' + backupHandlerCount);

const completedHandlers = backupDb.prepare(\"SELECT * FROM handler_records WHERE status='paid' ORDER BY id\").all();
console.log('\n已支付的handler_records：');
completedHandlers.forEach(h => {
    console.log('  handler ID: ' + h.id + ', order_id: ' + h.order_id + ', date: ' + h.date + ', amount: ' + h.amount);
});

// ===================== 7. transactions 表对比 =====================
console.log('\n\ntransactions 表数据量');
const backupTransactionsCount = backupDb.prepare(\"SELECT COUNT(*) as cnt FROM transactions\").get().cnt;
console.log('备份文件: ' + backupTransactionsCount);

const allTransactions = backupDb.prepare(\"SELECT * FROM transactions ORDER BY id\").all();
if (allTransactions.length > 0) {
    console.log('\n所有transactions：');
    allTransactions.forEach(t => {
        console.log('  transaction ID: ' + t.id + ', order_id: ' + t.order_id + ', date: ' + t.date + ', start_amount: ' + t.start_amount + ', end_amount: ' + t.end_amount + ', change_amount: ' + t.change_amount);
    });
}

// ===================== 8. 备份文件中的用户 =====================
console.log('\n\n用户表：');
const users = backupDb.prepare(\"SELECT * FROM users\").all();
users.forEach(u => {
    console.log('  user ID: ' + u.id + ', username: ' + u.username + ', role: ' + u.role);
});

// 关闭数据库
backupDb.close();

console.log('\n\n分析完成！');
