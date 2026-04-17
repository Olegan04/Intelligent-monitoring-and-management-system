let statsChart = null;

// Функция для нормализации типов (приводит к формату БД)
function normalizeCounterType(type) {
    const types = {
        'электричество': 'Электричество',
        'electricity': 'Электричество',
        'горячая вода': 'Горячая вода',
        'hot water': 'Горячая вода',
        'холодная вода': 'Холодная вода',
        'cold water': 'Холодная вода',
        'тепло': 'Тепло',
        'heat': 'Тепло',
        'газ': 'Газ',
        'gas': 'Газ'
    };
    return types[type.toLowerCase()] || type;
}


document.addEventListener('DOMContentLoaded', async () => {
    // Установка дат по умолчанию
    const today = new Date();
    const monthAgo = new Date();
    monthAgo.setDate(today.getDate() - 30);
    
    const statFrom = document.getElementById('statFrom');
    const statTo = document.getElementById('statTo');
    if (statFrom) statFrom.value = monthAgo.toISOString().split('T')[0];
    if (statTo) statTo.value = today.toISOString().split('T')[0];
    
    // Загрузка городов
    await loadCities();
    
    // Загрузка статистики
    await loadStatistics();
    
    // События
    const loadStatsBtn = document.getElementById('loadStatsBtn');
    if (loadStatsBtn) loadStatsBtn.addEventListener('click', loadStatistics);
    
    const citySelect = document.getElementById('citySelect');
    const loadAddressesBtn = document.getElementById('loadAddressesBtn');
    if (citySelect) citySelect.addEventListener('change', () => {
        loadAddressesBtn.disabled = !citySelect.value;
    });
    if (loadAddressesBtn) loadAddressesBtn.addEventListener('click', () => loadAddresses(citySelect.value));
    
    // Мобильное меню
    const mobileBtn = document.getElementById('mobileMenuBtn');
    const navLinks = document.querySelector('.nav-links');
    if (mobileBtn && navLinks) {
        mobileBtn.addEventListener('click', () => navLinks.classList.toggle('active'));
    }
});

async function loadCities() {
    try {
        const cities = await getCities();
        
        // Заполнение списка городов (секция "Города")
        const citiesList = document.getElementById('citiesList');
        if (citiesList) {
            if (cities.length === 0) {
                citiesList.innerHTML = '<div class="empty-message">Нет городов с умными счётчиками</div>';
            } else {
                citiesList.innerHTML = cities.map(city => `<div class="city-card"><i class="fas fa-city"></i><span>${city}</span></div>`).join('');
            }
        }
        
        // Заполнение выпадающего списка для выбора города (секция "Адреса")
        const citySelect = document.getElementById('citySelect');
        if (citySelect) {
            citySelect.innerHTML = '<option value="">Выберите город</option>' + cities.map(city => `<option value="${city}">${city}</option>`).join('');
        }
        
        // ✅ ДОБАВИТЬ ЭТОТ БЛОК: заполнение выпадающего списка для статистики
        const cityForStats = document.getElementById('cityForStats');
        if (cityForStats) {
            cityForStats.innerHTML = '<option value="">Выберите город</option>' + cities.map(city => `<option value="${city}">${city}</option>`).join('');
        }
    } catch (error) {
        console.error('Ошибка загрузки городов:', error);
        const citiesList = document.getElementById('citiesList');
        if (citiesList) citiesList.innerHTML = '<div class="error-message">Ошибка загрузки городов</div>';
    }
}

async function loadAddresses(city) {
    if (!city) return;
    try {
        const addresses = await getAddressesByCity(city);
        
        const container = document.getElementById('addressesList');
        if (!container) return;
        
        if (addresses.length === 0) {
            container.innerHTML = '<div class="empty-message">Нет адресов с умными счётчиками в этом городе</div>';
        } else {
            container.innerHTML = addresses.map(addr => `
                <div class="address-card">
                    <i class="fas fa-location-dot"></i>
                    <div>
                        <strong>ул. ${addr.street}, д. ${addr.house}</strong>
                        <span>кв. ${addr.flat}</span>
                    </div>
                </div>
            `).join('');
        }
    } catch (error) {
        console.error('Ошибка загрузки адресов:', error);
        const container = document.getElementById('addressesList');
        if (container) container.innerHTML = '<div class="error-message">Ошибка загрузки адресов</div>';
    }
}

async function loadStatistics() {
    const type = document.getElementById('statType')?.value || 'country';
    let counterType = document.getElementById('counterType')?.value || 'Электричество';
    
    // Нормализуем тип счётчика
    counterType = normalizeCounterType(counterType);
    
    const from = document.getElementById('statFrom')?.value;
    const to = document.getElementById('statTo')?.value;
    const city = document.getElementById('cityForStats')?.value;
    
    let params = { from, to };
    let data = [];
    
    try {
        if (type === 'country') {
            data = await getPublicStats('country', counterType, params);
        } else if (type === 'city') {
            if (!city) {
                const tbody = document.getElementById('statsTableBody');
                if (tbody) tbody.innerHTML = '<tr><td colspan="4">Выберите город для просмотра статистики</td></tr>';
                return;
            }
            params.city = city;
            data = await getPublicStats('city', counterType, params);
        } else {
            const tbody = document.getElementById('statsTableBody');
            if (tbody) tbody.innerHTML = '<tr><td colspan="4">Для просмотра улиц и домов войдите в личный кабинет</td></tr>';
            return;
        }
        
        const tbody = document.getElementById('statsTableBody');
        if (tbody) {
            if (!data || data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4">Нет данных за выбранный период</td></tr>';
            } else {
                tbody.innerHTML = data.map(item => `
                    <tr>
                        <td>${item.location || item.city || '-'}</td>
                        <td>${item.total_value || 0}</td>
                        <td>${(item.average_value || 0).toFixed(2)}</td>
                        <td>${item.readings_count || 0}</td>
                    </tr>
                `).join('');
            }
        }
        
        updateChart(data, type);
    } catch (error) {
        console.error('Ошибка загрузки статистики:', error);
        const tbody = document.getElementById('statsTableBody');
        if (tbody) tbody.innerHTML = '<tr><td colspan="4">Ошибка загрузки данных</td></tr>';
    }
}


function updateChart(data, type) {
    const ctx = document.getElementById('statsChart')?.getContext('2d');
    if (!ctx || !data || data.length === 0) return;
    
    if (statsChart) statsChart.destroy();
    
    const labels = data.map(item => item.location || item.city || '-');
    const values = data.map(item => item.total_value || 0);
    
    statsChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Суммарное потребление',
                data: values,
                backgroundColor: '#667eea',
                borderRadius: 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: { position: 'top' }
            }
        }
    });
}