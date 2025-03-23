const { IsolationForest } = require('isolation-forest');
const { db } = require('../config/firebase-config');

// Preprocess transaction data for the model
const preprocessTransactions = (transactions) => {
  console.log('Preprocessing transactions:', transactions.length);
  // Display transaction amounts to verify data
  console.log('Transaction amounts:', transactions.map(t => t.amount));
  
  return transactions.map(transaction => {
    // Make sure values are properly parsed as numbers
    const amount = parseFloat(transaction.amount);
    if (isNaN(amount)) {
      console.warn('Invalid amount found:', transaction.amount);
    }
    
    // Get the date from transaction
    const txDate = new Date(transaction.date);
    // Verify date is valid
    const isValidDate = !isNaN(txDate.getTime());
    if (!isValidDate) {
      console.warn('Invalid date found:', transaction.date);
    }
    
    // Extract numeric features with reasonable defaults if data is invalid
    return [
      // Use a default of 0 if amount is NaN
      isNaN(amount) ? 0 : amount,
      // Day of month (1-31) or 1 if invalid date
      isValidDate ? txDate.getDate() : 1,
      // Day of week (0-6) or 0 if invalid date
      isValidDate ? txDate.getDay() : 0,
      // Calculate recency in days (normalized to 0-1 range)
      isValidDate ? Math.min(1, (Date.now() - txDate.getTime()) / (1000 * 60 * 60 * 24 * 30)) : 0.5
    ];
  });
};

// Detect anomalies using a sliding window approach to maintain historical context
const detectAnomaliesWithSlidingWindow = (transactions) => {
  // Sort transactions by date (oldest first)
  transactions.sort((a, b) => new Date(a.date) - new Date(b.date));
  
  const anomalies = [];
  const windowSize = 10; // Consider past 10 transactions for context
  const minWindowSize = 5; // Minimum transactions needed for meaningful statistics
  
  // For each transaction (after we have enough context)
  for (let i = minWindowSize; i < transactions.length; i++) {
    const currentTx = transactions[i];
    
    // Look at previous transactions as context (not including current)
    // Use as many as available up to windowSize
    const availableContext = Math.min(windowSize, i);
    const contextWindow = transactions.slice(i - availableContext, i);
    const contextAmounts = contextWindow.map(t => parseFloat(t.amount));
    
    // Calculate statistics based on previous transactions only
    const mean = contextAmounts.reduce((sum, val) => sum + val, 0) / contextAmounts.length;
    const stdDev = Math.sqrt(
      contextAmounts.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / contextAmounts.length
    );
    
    // Calculate threshold based on historical context
    const threshold = mean + 2.5 * stdDev; // Using 2.5 standard deviations instead of 2
    
    // Check if current transaction exceeds historical threshold
    const currentAmount = parseFloat(currentTx.amount);
    if (currentAmount > threshold) {
      const score = (currentAmount - mean) / stdDev;
      
      // Generate reason based on how anomalous it is
      let reason;
      if (score > 5) {
        reason = `This expense of $${currentAmount.toFixed(2)} is extremely high compared to your typical ${currentTx.categoryName || ''} spending of around $${mean.toFixed(2)}.`;
      } else if (score > 3) {
        reason = `This expense is significantly higher than your average ${currentTx.categoryName || ''} spending from this time period.`;
      } else {
        reason = `This ${currentTx.categoryName || ''} expense is higher than your typical spending pattern at the time.`;
      }
      
      anomalies.push({
        ...currentTx,
        anomalyScore: score,
        reason: reason
      });
    }
  }
  
  return anomalies;
};

// Train model and detect anomalies within a specific category
const detectAnomaliesForCategory = async (userId, categoryId) => {
  try {
    console.log(`Starting anomaly detection for category: ${categoryId}, user: ${userId}`);
    
    // Fetch transactions for this user and category
    const snapshot = await db
      .collection('users')
      .doc(userId)
      .collection('transactions')
      .where('type', '==', 'expense')
      .where('category', '==', categoryId)
      .orderBy('date', 'asc') // Order by date (oldest first)
      .get();
    
    const transactions = [];
    snapshot.forEach(doc => {
      transactions.push({
        id: doc.id,
        ...doc.data()
      });
    });
    
    console.log(`Found ${transactions.length} transactions for category ${categoryId}`);
    
    // Need minimum number of transactions for meaningful analysis
    if (transactions.length < 5) {
      console.log(`Not enough transactions for category ${categoryId} (${transactions.length}/5)`);
      return { 
        anomalies: [],
        categoryId,
        message: "Not enough transaction data for anomaly detection"
      };
    }
    
    try {
      // First try the ML approach with Isolation Forest
      // Preprocess data
      const features = preprocessTransactions(transactions);
      console.log('First two feature sets:', features.slice(0, 2));
      
      // Configure and train the isolation forest model
      const isolationForest = new IsolationForest({
        nEstimators: 100,
        maxSamples: 'auto',
        contamination: 0.1, // Expected fraction of anomalies
        maxFeatures: features[0].length
      });
      
      console.log('Training isolation forest model...');
      // Train the model
      isolationForest.fit(features);
      
      // Get anomaly scores
      const scores = isolationForest.scores(features);
      
      // Check if any scores are NaN
      if (scores.some(score => isNaN(score))) {
        throw new Error("Invalid scores generated by isolation forest");
      }
      
      console.log('Anomaly scores range:', 
        Math.min(...scores), 'to', Math.max(...scores),
        'Threshold:', -0.3);
      
      // Add scores to transactions and identify anomalies
      const scoredTransactions = transactions.map((transaction, index) => ({
        ...transaction,
        anomalyScore: scores[index]
      }));
      
      // Extract anomalies (more negative scores are more anomalous)
      const anomalies = scoredTransactions
        .filter(t => t.anomalyScore < -0.3) // Adjusted threshold for more sensitivity
        .sort((a, b) => a.anomalyScore - b.anomalyScore);
      
      console.log(`Found ${anomalies.length} ML anomalies in category ${categoryId}`);
      
      // Add context to each anomaly
      anomalies.forEach(anomaly => {
        anomaly.reason = generateAnomalyReason(anomaly, transactions);
        
        // Make sure categoryName is set for displaying in UI
        if (!anomaly.categoryName && anomaly.category) {
          const categoryObj = transactions.find(t => t.categoryName && t.category === categoryId);
          if (categoryObj) {
            anomaly.categoryName = categoryObj.categoryName;
          } else {
            anomaly.categoryName = categoryId.charAt(0).toUpperCase() + categoryId.slice(1);
          }
        }
      });
      
      return { anomalies, categoryId };
    } catch (error) {
      console.error('Error in isolation forest processing:', error.message);
      
      // Fallback to sliding window anomaly detection
      console.log('Falling back to sliding window detection method');
      
      // Use sliding window approach
      const anomalies = detectAnomaliesWithSlidingWindow(transactions);
      
      console.log(`Found ${anomalies.length} sliding window anomalies in category ${categoryId}`);
      
      if (anomalies.length > 0) {
        console.log('Anomalies:', anomalies.map(a => ({ 
          amount: a.amount, 
          score: a.anomalyScore,
          date: new Date(a.date).toISOString().split('T')[0]
        })));
        
        // Make sure categoryName is set for displaying in UI
        anomalies.forEach(anomaly => {
          if (!anomaly.categoryName && anomaly.category) {
            const categoryObj = transactions.find(t => t.categoryName && t.category === categoryId);
            if (categoryObj) {
              anomaly.categoryName = categoryObj.categoryName;
            } else {
              anomaly.categoryName = categoryId.charAt(0).toUpperCase() + categoryId.slice(1);
            }
          }
        });
      }
      
      return { 
        anomalies, 
        categoryId,
        method: 'Sliding window detection'
      };
    }
  } catch (error) {
    console.error('Error in anomaly detection:', error);
    throw error;
  }
};

// Generate human-readable reason for the anomaly
const generateAnomalyReason = (anomaly, allTransactions) => {
  // Calculate category statistics
  const amounts = allTransactions.map(t => parseFloat(t.amount));
  const avgAmount = amounts.reduce((sum, val) => sum + val, 0) / amounts.length;
  const maxAmount = Math.max(...amounts);
  
  // Calculate how much this anomaly deviates
  const amountRatio = anomaly.amount / avgAmount;
  
  if (amountRatio > 3) {
    return `This expense is ${amountRatio.toFixed(1)}x higher than your average ${anomaly.categoryName || ''} spending.`;
  } else if (amountRatio > 1.5) {
    return `This expense is significantly higher than your typical ${anomaly.categoryName || ''} transactions.`;
  } else if (anomaly.amount === maxAmount) {
    return `This is your largest recorded expense in the ${anomaly.categoryName || ''} category.`;
  } else {
    // Unusual timing or pattern
    const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const day = weekday[new Date(anomaly.date).getDay()];
    return `This ${anomaly.categoryName || ''} expense has an unusual pattern (timing, amount, or frequency) compared to your typical spending.`;
  }
};

// Detect anomalies across all categories for a user
const detectAnomaliesForUser = async (userId) => {
  try {
    console.log('Starting anomaly detection for user:', userId);
    
    // First, get all categories this user has transactions for
    const transactionsSnapshot = await db
      .collection('users')
      .doc(userId)
      .collection('transactions')
      .where('type', '==', 'expense')
      .get();
    
    console.log('Found expenses:', transactionsSnapshot.size);
    
    if (transactionsSnapshot.size === 0) {
      return []; // Return early if no transactions
    }
    
    const categories = new Set();
    transactionsSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.category) {
        categories.add(data.category);
      }
    });
    
    console.log('Found unique categories:', Array.from(categories));
    
    if (categories.size === 0) {
      return []; // Return early if no categories
    }
    
    // Run anomaly detection for each category
    const categoryPromises = Array.from(categories).map(categoryId => {
      console.log('Processing category:', categoryId);
      return detectAnomaliesForCategory(userId, categoryId);
    });
    
    const results = await Promise.all(categoryPromises);
    console.log('Category results:', results.map(r => ({
      categoryId: r.categoryId,
      anomalyCount: r.anomalies?.length || 0
    })));
    
    // Combine results - sort by date (newest first) and then by anomaly score
    const allAnomalies = results
      .flatMap(result => result.anomalies)
      .sort((a, b) => {
        // First sort by date (newest first)
        const dateA = new Date(a.date);
        const dateB = new Date(b.date);
        if (dateB.getTime() !== dateA.getTime()) {
          return dateB.getTime() - dateA.getTime();
        }
        
        // If dates are equal, sort by anomaly score (most anomalous first)
        return Math.abs(b.anomalyScore) - Math.abs(a.anomalyScore);
      });
    
    console.log('Total anomalies found:', allAnomalies.length);
    return allAnomalies;
  } catch (error) {
    console.error('Error in user anomaly detection:', error);
    throw error;
  }
};

// Run anomaly detection on a single transaction to check if it's anomalous
const checkTransactionForAnomaly = async (userId, transaction) => {
  try {
    const categoryId = transaction.category;
    
    // Get past transactions in this category
    const snapshot = await db
      .collection('users')
      .doc(userId)
      .collection('transactions')
      .where('type', '==', 'expense')
      .where('category', '==', categoryId)
      .orderBy('date', 'asc') // Order by date (oldest first)
      .get();
    
    const pastTransactions = [];
    snapshot.forEach(doc => {
      // Don't include the current transaction if it's already in the database
      if (doc.id !== transaction.id) {
        pastTransactions.push({
          id: doc.id,
          ...doc.data()
        });
      }
    });
    
    // Need minimum number of transactions for meaningful analysis
    if (pastTransactions.length < 5) {
      return null; // Not enough data to determine if it's an anomaly
    }
    
    // Add the current transaction to the end
    const allTransactions = [...pastTransactions, transaction];
    
    // Calculate statistics based on previous transactions only
    const contextAmounts = pastTransactions.map(t => parseFloat(t.amount));
    const mean = contextAmounts.reduce((sum, val) => sum + val, 0) / contextAmounts.length;
    const stdDev = Math.sqrt(
      contextAmounts.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / contextAmounts.length
    );
    
    // Calculate threshold
    const threshold = mean + 2.5 * stdDev;
    
    // Check if current transaction exceeds threshold
    const currentAmount = parseFloat(transaction.amount);
    if (currentAmount > threshold) {
      const score = (currentAmount - mean) / stdDev;
      
      // Generate reason
      let reason;
      if (score > 5) {
        reason = `This expense of $${currentAmount.toFixed(2)} is extremely high compared to your typical ${transaction.categoryName || ''} spending of around $${mean.toFixed(2)}.`;
      } else if (score > 3) {
        reason = `This expense is significantly higher than your average ${transaction.categoryName || ''} spending.`;
      } else {
        reason = `This ${transaction.categoryName || ''} expense is higher than your typical spending pattern.`;
      }
      
      return {
        ...transaction,
        anomalyScore: score,
        reason,
        isAnomaly: true
      };
    }
    
    return {
      ...transaction,
      isAnomaly: false
    };
  } catch (error) {
    console.error('Error checking transaction for anomaly:', error);
    return null;
  }
};

module.exports = { 
  detectAnomaliesForUser,
  detectAnomaliesForCategory,
  checkTransactionForAnomaly
};