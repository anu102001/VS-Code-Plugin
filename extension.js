
const vscode = require('vscode');
const { initializeApp } = require('firebase/app');
let open;
(async () => {
	open = (await import('open')).default;
})();
const http = require('http');
const { getAuth } = require('firebase/auth');
const { getFirestore, collection, doc, updateDoc, deleteDoc, getDocs, query, where, serverTimestamp, addDoc, getDoc } = require('firebase/firestore');

// Initialize Firebase
const firebaseApp = initializeApp({
	apiKey: APIKey,
	authDomain: "",
	projectId: "",
	storageBucket: "",
	messagingSenderId: "",
	appId: ""
});

// Get Firebase services
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

module.exports = { auth, db };

let currentUserDetails = null;

Object.defineProperty(exports, "__esModule", { value: true });

function activate(context) {
	console.log('Activating Firebase Plugin...');

	let disposable = vscode.commands.registerCommand('firebase-plugin.helloWorld', function () {
		console.log('firebase-plugin.helloWorld command executed');
		vscode.window.showInformationMessage('Hello World from Firebase Plugin!');
	});

	context.subscriptions.push(disposable);
	context.globalState.update('currentUserDetails', null);
	// Sidebar Webview Panel
	let panel = vscode.window.createWebviewPanel(
		'firebaseExtension',
		'Firebase Project Manager',
		vscode.ViewColumn.One,
		{ enableScripts: true }
	);

	// Webview HTML Content
	panel.webview.html = getWebviewContent();
	panel.webview.postMessage({ command: 'updateUser', user: null });
	panel.webview.postMessage({ command: 'updateProjects', projects: [] });

	vscode.window.onDidChangeActiveTextEditor(() => {
		// Recheck if user is logged in
		const storedUser = context.globalState.get('currentUserDetails', null);
		if (storedUser) {
			currentUserDetails = JSON.parse(storedUser);
			fetchProjects(panel);
		}
		panel.webview.postMessage({ command: 'updateUser', user: currentUserDetails });
	});
	// Handle messages from the webview
	panel.webview.onDidReceiveMessage(async (message) => {
		console.log('Received message:', message);
		switch (message.command) {
			case 'login':
				await login(panel, context);
				break;
			case 'logout':
				await logout(panel, context);
				break;
			case 'saveProject':
				const projectName = message.projectName;
				await saveProject(projectName.trim(), panel);
				break;
			case 'updateProject':
				const updateName = message.projectName;
				await updateProject(updateName.trim(), panel);
				break;
			case 'deleteProject':
				const deleteName = message.projectName;
				await deleteProject(deleteName.trim(), panel);
				break;
			case 'fetchProjects':
				await fetchProjects(panel);
				break;
		}
	}, undefined, context.subscriptions);
}

function deactivate() { }

module.exports = {
	activate,
	deactivate,
};

// Firebase login
async function login(panel, context) {
	try {
		const clientId = ''; // Replace with your Google Client ID
		const clientSecret = ''; // Replace with your Google Client Secret
		const firebaseWebApiKey = ''; // Replace with your Firebase Web API Key
		const redirectUri = 'http://localhost:3000/auth'; // Local server for receiving the OAuth token
		const authUrl = `https://accounts.google.com/o/oauth2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=email profile`;

		// Open the browser for user login
		await open(authUrl);
		vscode.window.showInformationMessage('Please complete the login in your browser.');

		// Start a temporary server to receive the redirect
		const server = http.createServer(async (req, res) => {
			if (req.url.startsWith('/auth')) {
				const urlParams = new URLSearchParams(req.url.split('?')[1]);
				const code = urlParams.get('code');

				// Exchange the authorization code for an access token
				const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({
						code,
						client_id: clientId,
						client_secret: clientSecret,
						redirect_uri: redirectUri,
						grant_type: 'authorization_code',
					}),
				});

				const tokenData = await tokenResponse.json();

				// Check for the ID token
				// @ts-ignore
				if (!tokenData.id_token) {
					throw new Error('Unable to retrieve Google id_token');
				}
				// @ts-ignore
				const googleIdToken = tokenData.id_token;

				// Exchange Google ID token for Firebase token+
				const firebaseTokenResponse = await fetch(
					`https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${firebaseWebApiKey}`, // Use your Firebase Web API Key
					{
						method: 'POST',
						body: JSON.stringify({
							postBody: `id_token=${googleIdToken}&providerId=google.com`,
							requestUri: 'http://localhost', // Should match an authorized domain
							returnSecureToken: true,
						}),
						headers: { 'Content-Type': 'application/json' },
					}
				);

				currentUserDetails = await firebaseTokenResponse.json();

				// Store the currentUserDetails in globalState
				context.globalState.update('currentUserDetails', JSON.stringify(currentUserDetails));

				console.log(currentUserDetails)

				// @ts-ignore
				vscode.window.showInformationMessage(`Logged in as ${currentUserDetails.displayName}`);
				panel.webview.postMessage({ command: 'updateUser', user: currentUserDetails });
				fetchProjects(panel);
				// Respond to the OAuth callback
				res.writeHead(200, { 'Content-Type': 'text/html' });
				res.end('<h1>Login Successful! You can now close this tab.</h1>');
				// Close the server
				server.close();
			} else {
				res.writeHead(404);
				res.end();
			}
		});

		// Listen for OAuth response on localhost
		server.listen(3000, () => console.log('Listening for OAuth response on http://localhost:3000/auth'));
	} catch (error) {
		vscode.window.showErrorMessage(`Login failed: ${error.message}`);
	}
}

async function logout(panel, context) {
	try {
		await auth.signOut();
		currentUserDetails = null;
		context.globalState.update('currentUserDetails', null);
		vscode.window.showInformationMessage('Logged out');
		panel.webview.postMessage({ command: 'updateUser', user: null });
		panel.webview.postMessage({ command: 'updateProjects', projects: [] });
	} catch (error) {
		vscode.window.showErrorMessage(`Logout failed: ${error.message}`);
	}
}

async function saveProject(projectName, panel) {
	if (!currentUserDetails || !currentUserDetails.email) {
		vscode.window.showErrorMessage('You need to log in first');
		return;
	}
	console.log('User Email:', currentUserDetails.email);

	const files = getWorkspaceFiles();
	if (!files || files.length === 0) {
		vscode.window.showErrorMessage('No files to save');
		return;
	}

	try {
		const q = query(
			collection(db, 'projects'),
			where('owner', '==', currentUserDetails.email),
			where('projectName', '==', projectName)
		);
		const snapshot = await getDocs(q);

		if (!snapshot.empty) {
			// Project with the same name and owner already exists
			vscode.window.showErrorMessage(`A project named "${projectName}" already exists for this user.`);
			return;
		}

		// If no duplicate is found, proceed with saving the project
		const docRef = await addDoc(collection(db, 'projects'), {
			owner: currentUserDetails.email,
			files,
			createdAt: serverTimestamp(),
			projectName, // Optionally store the project name as a field
		});
		console.log('Document written with ID: ', docRef.id);
		fetchProjects(panel);
		vscode.window.showInformationMessage(`Project "${projectName}" saved successfully`);
	} catch (error) {
		console.error('Error saving project:', error);
		vscode.window.showErrorMessage(`Failed to save project: ${error.message}`);
	}
}

// Update existing project
async function updateProject(projectName, panel) {
	if (!currentUserDetails || !currentUserDetails.email) {
		vscode.window.showErrorMessage('You need to log in first');
		return;
	}
	console.log('User Email:', currentUserDetails.email);
	const files = getWorkspaceFiles();
	try {
		// Query the document based on owner and projectName
		const q = query(
			collection(db, 'projects'),
			where('owner', '==', currentUserDetails.email),
			where('projectName', '==', projectName)
		);

		const snapshot = await getDocs(q);

		// Check if a matching document is found
		if (snapshot.empty) {
			vscode.window.showErrorMessage(`No project found with the name "${projectName}"`);
			return;
		}

		// Update the first matching document
		const docToUpdate = snapshot.docs[0];
		await updateDoc(doc(db, 'projects', docToUpdate.id), {
			files,
			updatedAt: serverTimestamp(), // Optionally add an update timestamp
		});
		fetchProjects(panel);
		console.log('Project updated successfully');
		vscode.window.showInformationMessage(`Project "${projectName}" updated successfully`);
	} catch (error) {
		console.error('Error updating project:', error);
		vscode.window.showErrorMessage(`Failed to update project: ${error.message}`);
	}
}


// Delete project from Firestore
async function deleteProject(projectName, panel) {
	if (!currentUserDetails || !currentUserDetails.email) {
		vscode.window.showErrorMessage('You need to log in first');
		return;
	}

	try {
		// Query to find the document with the matching owner and projectName
		const q = query(
			collection(db, 'projects'),
			where('owner', '==', currentUserDetails.email),
			where('projectName', '==', projectName)
		);
		const snapshot = await getDocs(q);

		if (snapshot.empty) {
			vscode.window.showErrorMessage(`No project named "${projectName}" found for this user.`);
			return;
		}

		// Delete all matching documents (there should ideally only be one)
		const deletePromises = snapshot.docs.map(doc => deleteDoc(doc.ref));
		await Promise.all(deletePromises);
		vscode.window.showInformationMessage(`Project "${projectName}" deleted successfully.`);
		fetchProjects(panel);
	} catch (error) {
		console.error('Error deleting project:', error);
		vscode.window.showErrorMessage(`Failed to delete project: ${error.message}`);
	}
}


// Fetch projects from Firestore
async function fetchProjects(panel) {
	if (!currentUserDetails) {
		vscode.window.showErrorMessage('You need to log in first');
		return;
	}
	try {
		const q = query(collection(db, 'projects'), where('owner', '==', currentUserDetails.email)); // Ensure collection name matches
		const snapshot = await getDocs(q);
		// If no projects are found, return an empty array or message
		if (snapshot.empty) {
			vscode.window.showInformationMessage('No projects found');
			panel.webview.postMessage({ command: 'updateProjects', projects: [] });
			return;
		}

		let projects = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
		panel.webview.postMessage({ command: 'updateProjects', projects });
	} catch (error) {
		console.error('Error fetching projects:', error);
		vscode.window.showErrorMessage(`Failed to fetch projects: ${error.message}`);
		return;
	}
}

// Get list of files in the workspace
function getWorkspaceFiles() {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) {
		vscode.window.showErrorMessage('No workspace is open');
		return [];
	}
	const folder = workspaceFolders[0].uri.fsPath;
	const fs = require('fs');
	const path = require('path');

	function readFiles(dir) {
		return fs.readdirSync(dir).flatMap(file => {
			const fullPath = path.join(dir, file);
			return fs.statSync(fullPath).isDirectory() ? readFiles(fullPath) : fullPath;
		});
	}

	return readFiles(folder);
}

// Webview HTML content
function getWebviewContent() {
	return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Firebase Project Manager</title>
			<style>
                #projects ul {
                    list-style-type: none;
                    padding: 0;
                }
                #projects li {
                    padding: 8px;
                    border: 1px solid #ddd;
                    margin-bottom: 8px;
					margin-top: 8px;
                    border-radius: 4px;
					color: white;
					font-size: 16px;
                }
				
				.files {
					border-radius: 0px !important;
					font-size: 12px;
            </style>
        </head>
        <body>
            <h1>Firebase Project Manager</h1>
            <div id="auth-section">
                <button id="login-btn" onclick="login()">Sign In</button>
            </div>
            <div id="main-section" style="display: none;">
                <input type="text" id="projectName" placeholder="Enter project name">
                <button onclick="saveProject()">Save Project</button>
                <button onclick="updateProject()">Update Project</button>
                <button onclick="deleteProject()">Delete Project</button>
                <button onclick="getProjects()">Get Projects</button>
                <button onclick="logout()">Logout</button>
                <div id="projects"></div>
            </div>
            <script>
                console.log('Webview script loaded');
                const vscode = acquireVsCodeApi();

                function login() {
                    vscode.postMessage({ command: 'login' });
                }

                function logout() {
                    vscode.postMessage({ command: 'logout' });
                }

                function saveProject() {
                    const projectName = document.getElementById('projectName').value;
                    vscode.postMessage({ command: 'saveProject', projectName });
                }

                function updateProject() {
                    const projectName = document.getElementById('projectName').value;
                    vscode.postMessage({ command: 'updateProject', projectName });
                }

                function deleteProject() {
                    const projectName = document.getElementById('projectName').value;
                    vscode.postMessage({ command: 'deleteProject', projectName });
                }

                function getProjects() {
                    vscode.postMessage({ command: 'fetchProjects' });
                }

                // Listen for messages from the extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.command === 'updateUser') {
                        const isLoggedIn = message.user !== null;
                        document.getElementById('auth-section').style.display = isLoggedIn ? 'none' : 'block';
                        document.getElementById('main-section').style.display = isLoggedIn ? 'block' : 'none';
                    }

					if (message.command === 'updateProjects') {
                        const projectList = document.getElementById('projects');
						const projects = message.projects;
                        projectList.innerHTML = ''; // Clear existing projects
                        if (projects.length === 0) {
                            projectList.innerHTML = '<li>No projects found</li>';
                        } else {
                            projects.forEach(project => {
                                const listItem = document.createElement('li');
								let projectContent = \`Project Name: \${project.projectName}, Owner: \${project.owner}\`;

								if (project.files && project.files.length > 0) {
									projectContent += \`<br>Files:<ul>\`;
									project.files.forEach(file => {
										projectContent += \`<li class="files">\${file}</li>\`;
									});
									projectContent += \`</ul>\`;
								}

                                listItem.innerHTML = projectContent;
            					projectList.appendChild(listItem);
                            });
                        }
                    }
                });
            </script>
        </body>
        </html>	
    `;
}


