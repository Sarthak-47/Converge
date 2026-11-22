// The first-run screen: asks the main process to check and save the server address, which then opens it.
const form = document.getElementById('connect')
const input = document.getElementById('server')
const error = document.getElementById('error')
const submit = document.getElementById('submit')

window.convergeConnect.current().then((current) => {
  if (current) input.value = current
  input.focus()
  input.select()
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  error.textContent = ''
  submit.disabled = true
  submit.textContent = 'Connecting…'
  const result = await window.convergeConnect.connect(input.value)
  if (!result.ok) {
    error.textContent = result.error
    submit.disabled = false
    submit.textContent = 'Connect'
  }
})
